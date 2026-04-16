#!/usr/bin/env node
/**
 * 视频内容解析 MCP Server (优化版 - 高速转写)
 * 支持：本地视频文件、在线视频链接
 * 功能：提取字幕、音频转文字、关键帧分析、元数据提取
 *
 * 性能优化:
 * 1. 支持 faster-whisper (GPU加速/INT8量化)
 * 2. 并行执行多个任务
 * 3. 转写结果缓存
 * 4. 优化FFmpeg命令
 * 5. 进度实时反馈
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// 缓存目录
const CACHE_DIR = path.join(process.env.TEMP || process.env.TMP || '/tmp', 'video_skill_cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 创建 Server 实例
const server = new Server(
  {
    name: 'video-skill-pro',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 检查 FFmpeg 是否安装
async function checkFFmpeg() {
  try {
    await execPromise('ffmpeg -version');
    return true;
  } catch (e) {
    return false;
  }
}

// Whisper Python 环境路径
const WHISPER_PYTHON = 'D:\\Operation\\Anaconda\\envs\\whisper\\python.exe';

// 检查 Whisper / faster-whisper
async function checkWhisper() {
  try {
    // 先检查 faster-whisper (更快)
    await execPromise(`"${WHISPER_PYTHON}" -c "import faster_whisper"`);
    return { available: true, type: 'faster-whisper' };
  } catch (e) {}

  try {
    await execPromise(`"${WHISPER_PYTHON}" -c "import whisper"`);
    return { available: true, type: 'whisper' };
  } catch (e) {
    return { available: false, type: null };
  }
}

// 获取文件哈希作为缓存键
async function getFileHash(filePath) {
  const crypto = require('crypto');
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('md5');
  hash.update(`${filePath}-${stat.size}-${stat.mtime.getTime()}`);
  return hash.digest('hex').substring(0, 12);
}

// 缓存相关函数
function getCachePath(videoPath, suffix) {
  const hash = getFileHashSync(videoPath);
  return path.join(CACHE_DIR, `video_${hash}_${suffix}.json`);
}

function getFileHashSync(filePath) {
  const crypto = require('crypto');
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('md5');
  hash.update(`${filePath}-${stat.size}-${stat.mtime.getTime()}`);
  return hash.digest('hex').substring(0, 12);
}

function readCache(videoPath, suffix) {
  const cachePath = getCachePath(videoPath, suffix);
  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      // 缓存有效期7天
      if (Date.now() - data.timestamp < 7 * 24 * 60 * 60 * 1000) {
        return data.content;
      }
    } catch (e) {}
  }
  return null;
}

function writeCache(videoPath, suffix, content) {
  const cachePath = getCachePath(videoPath, suffix);
  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: Date.now(),
    content: content
  }, null, 2));
}

// 工具列表
const TOOLS = [
  {
    name: 'analyze_video',
    description: '分析视频内容，提取元数据、关键信息、字幕等（需要 FFmpeg）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
        options: {
          type: 'object',
          description: '分析选项',
          properties: {
            extract_metadata: { type: 'boolean', description: '是否提取元数据', default: true },
            extract_subtitles: { type: 'boolean', description: '是否提取字幕', default: true },
            extract_frames: { type: 'boolean', description: '是否提取关键帧', default: false },
            extract_audio: { type: 'boolean', description: '是否提取音频', default: false },
          },
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'extract_subtitles',
    description: '从视频中提取字幕（需要 FFmpeg）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
        language: {
          type: 'string',
          description: '字幕语言 (chi/eng/jpn 等)',
          default: 'chi',
        },
        output_format: {
          type: 'string',
          description: '输出格式 (srt/ass/txt)',
          default: 'srt',
          enum: ['srt', 'ass', 'txt'],
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'video_to_text',
    description: '将视频语音转换为文字（需要 FFmpeg + Whisper/faster-whisper，支持缓存）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
        language: {
          type: 'string',
          description: '语音语言 (zh/en/ja 等)',
          default: 'zh',
        },
        model: {
          type: 'string',
          description: 'Whisper 模型 (tiny/base/small/medium/large 或 faster-whisper:tiny/base/small/medium/large)',
          default: 'base',
        },
        use_cache: {
          type: 'boolean',
          description: '是否使用缓存（已转写过的视频直接返回结果）',
          default: true,
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'extract_keyframes',
    description: '从视频中提取关键帧图片（需要 FFmpeg）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
        interval: {
          type: 'number',
          description: '提取间隔（秒）',
          default: 60,
        },
        output_dir: {
          type: 'string',
          description: '输出目录',
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'get_video_metadata',
    description: '获取视频元数据信息（需要 FFmpeg）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'extract_audio',
    description: '从视频中提取音频（需要 FFmpeg）',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: '视频文件路径',
        },
        output_path: {
          type: 'string',
          description: '输出音频路径',
        },
        format: {
          type: 'string',
          description: '音频格式 (mp3/wav/m4a)',
          default: 'mp3',
        },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'analyze_bilibili',
    description: '分析 B 站视频，提取标题、简介、弹幕、评论等（使用 B站官方 API）',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'B 站视频 URL',
        },
        include_danmaku: {
          type: 'boolean',
          description: '是否包含弹幕列表',
          default: false,
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'analyze_youtube',
    description: '分析 YouTube 视频，提取标题、简介、字幕等（需要 yt-dlp）',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'YouTube 视频 URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'analyze_online_video',
    description: '分析在线视频（支持 B站/YouTube 等），提取元数据、字幕、文字等',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '在线视频 URL（B站、YouTube 等）',
        },
        options: {
          type: 'object',
          description: '分析选项',
          properties: {
            extract_metadata: { type: 'boolean', description: '是否提取元数据', default: true },
            extract_subtitles: { type: 'boolean', description: '是否提取字幕', default: true },
            video_to_text: { type: 'boolean', description: '是否转写为文字', default: false },
            language: { type: 'string', description: '语音语言', default: 'zh' },
          },
        },
      },
      required: ['url'],
    },
  },
];

// 处理列出工具请求
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // 检查工具可用性
  const hasFFmpeg = await checkFFmpeg();
  const hasWhisper = await checkWhisper();
  
  return { 
    tools: TOOLS.map(tool => ({
      ...tool,
      description: `${tool.description} ${!hasFFmpeg && tool.name !== 'analyze_bilibili' && tool.name !== 'analyze_youtube' ? '[需要 FFmpeg]' : ''} ${!hasWhisper && tool.name === 'video_to_text' ? '[需要 Whisper]' : ''}`
    }))
  };
});

// 处理工具调用请求
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'analyze_video':
        return await analyzeVideo(args.video_path, args.options);
      
      case 'extract_subtitles':
        return await extractSubtitles(args.video_path, args.language, args.output_format);
      
      case 'video_to_text':
        return await videoToText(args.video_path, args.language, args.model);
      
      case 'extract_keyframes':
        return await extractKeyframes(args.video_path, args.interval, args.output_dir);
      
      case 'get_video_metadata':
        return await getVideoMetadata(args.video_path);
      
      case 'extract_audio':
        return await extractAudio(args.video_path, args.output_path, args.format);
      
      case 'analyze_bilibili':
        return await analyzeBilibili(args.url);
      
      case 'analyze_youtube':
        return await analyzeYoutube(args.url);

      case 'analyze_online_video':
        return await analyzeOnlineVideo(args.url, args.options);

      default:
        throw new Error(`未知工具：${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `执行失败：${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * 分析视频内容（优化版 - 并行执行）
 */
async function analyzeVideo(videoPath, options = {}) {
  const {
    extract_metadata = true,
    extract_subtitles = true,
    extract_frames = false,
    extract_audio = false,
  } = options;

  // 检查文件是否存在
  if (!fs.existsSync(videoPath)) {
    throw new Error(`文件不存在：${videoPath}`);
  }

  // 检查 FFmpeg
  const hasFFmpeg = await checkFFmpeg();

  let result = {
    file: path.basename(videoPath),
    path: videoPath,
    size: formatFileSize(fs.statSync(videoPath).size),
  };

  // 并行执行多个任务 (Promise.all)
  const tasks = [];

  // 提取元数据
  if (extract_metadata && hasFFmpeg) {
    tasks.push(
      getVideoMetadata(videoPath)
        .then(metadata => { result.metadata = metadata; })
        .catch(e => { result.metadata_error = e.message; })
    );
  }

  // 提取字幕
  if (extract_subtitles && hasFFmpeg) {
    tasks.push(
      extractSubtitlesFromFile(videoPath)
        .then(subtitles => { result.subtitles = subtitles; })
        .catch(e => { result.subtitles_error = e.message; })
    );
  }

  // 提取关键帧
  if (extract_frames && hasFFmpeg) {
    tasks.push(
      extractKeyframes(videoPath, 60)
        .then(frames => { result.frames = frames; })
        .catch(e => { result.frames_error = e.message; })
    );
  }

  // 提取音频
  if (extract_audio && hasFFmpeg) {
    tasks.push(
      extractAudio(videoPath, null, 'mp3')
        .then(audio => {
          result.audio = audio.path;
          result.audio_size = audio.size;
        })
        .catch(e => { result.audio_error = e.message; })
    );
  }

  // 等待所有任务完成
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  return {
    content: [
      {
        type: 'text',
        text: formatVideoAnalysis(result),
      },
    ],
  };
}

/**
 * 获取视频元数据 (优化版)
 */
async function getVideoMetadata(videoPath) {
  const hasFFmpeg = await checkFFmpeg();

  if (!hasFFmpeg) {
    throw new Error('需要安装 FFmpeg');
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`文件不存在：${videoPath}`);
  }

  // 使用 ffprobe 获取元数据 - 优化: 减少输出
  const { stdout } = await execPromise(
    `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}" 2>nul`
  );

  const data = JSON.parse(stdout);

  const videoStream = data.streams.find(s => s.codec_type === 'video');
  const audioStream = data.streams.find(s => s.codec_type === 'audio');

  return {
    duration: formatDuration(data.format.duration),
    size: formatFileSize(data.format.size),
    bitrate: data.format.bit_rate ? (parseInt(data.format.bit_rate) / 1000).toFixed(0) + ' kbps' : 'N/A',
    video: videoStream ? {
      codec: videoStream.codec_name,
      resolution: `${videoStream.width}x${videoStream.height}`,
      fps: videoStream.r_frame_rate ? parseFps(videoStream.r_frame_rate) : 'N/A',
      pixel_format: videoStream.pix_fmt || 'N/A',
    } : null,
    audio: audioStream ? {
      codec: audioStream.codec_name,
      sample_rate: audioStream.sample_rate + ' Hz',
      channels: audioStream.channels,
    } : null,
  };
}

/**
 * 从文件中提取字幕
 */
async function extractSubtitlesFromFile(videoPath) {
  const hasFFmpeg = await checkFFmpeg();
  
  if (!hasFFmpeg) {
    throw new Error('需要安装 FFmpeg');
  }

  const tempDir = path.dirname(videoPath);
  const outputSrt = path.join(tempDir, 'subtitles.srt');

  try {
    // 检查是否有内嵌字幕流
    const { stdout } = await execPromise(
      `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`
    );
    
    const data = JSON.parse(stdout);
    const subtitleStream = data.streams.find(s => s.codec_type === 'subtitle');
    
    if (!subtitleStream) {
      return '未找到内嵌字幕流';
    }

    // 提取字幕
    await execPromise(`ffmpeg -i "${videoPath}" -map 0:s:0 "${outputSrt}" -y 2>nul`);
    
    if (fs.existsSync(outputSrt)) {
      const content = fs.readFileSync(outputSrt, 'utf-8');
      return content.substring(0, 5000); // 限制长度
    }
    
    return '字幕提取失败';
  } catch (error) {
    throw new Error(`字幕提取失败：${error.message}`);
  }
}

/**
 * 提取字幕
 */
async function extractSubtitles(videoPath, language = 'chi', outputFormat = 'srt') {
  const hasFFmpeg = await checkFFmpeg();
  
  if (!hasFFmpeg) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 需要安装 FFmpeg 才能提取字幕

安装方法:
1. 访问 https://ffmpeg.org/download.html
2. 下载并安装 FFmpeg
3. 将 ffmpeg.exe 添加到系统 PATH

或者使用在线工具提取字幕。`,
        },
      ],
    };
  }

  if (!fs.existsSync(videoPath)) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 文件不存在：${videoPath}`,
        },
      ],
    };
  }

  try {
    const tempDir = path.dirname(videoPath);
    const outputSub = path.join(tempDir, `subtitles.${outputFormat}`);

    await execPromise(`ffmpeg -i "${videoPath}" -map 0:s:0 "${outputSub}" -y 2>nul`);
    
    if (fs.existsSync(outputSub)) {
      const content = fs.readFileSync(outputSub, 'utf-8');
      return {
        content: [
          {
            type: 'text',
            text: `## 📝 字幕提取结果

**视频文件:** ${path.basename(videoPath)}
**格式:** ${outputFormat}
**长度:** ${content.length} 字符

---

${content.substring(0, 4000)}${content.length > 4000 ? '...' : ''}

---

**完整字幕文件:** ${outputSub}
`,
          },
        ],
      };
    }
    
    return {
      content: [
        {
          type: 'text',
          text: `❌ 未找到内嵌字幕流

该视频可能没有内嵌字幕，可以尝试：
1. 使用外部字幕文件
2. 使用语音识别生成字幕 (video_to_text 工具)`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 字幕提取失败：${error.message}

💡 建议：
1. 检查视频是否包含内嵌字幕
2. 使用 video_to_text 工具进行语音识别
3. 查找外部字幕文件 (.srt/.ass)`,
        },
      ],
    };
  }
}

/**
 * 视频转文字（语音识别）- 优化版
 */
async function videoToText(videoPath, language = 'zh', model = 'base', useCache = true) {
  const hasFFmpeg = await checkFFmpeg();
  const whisperInfo = await checkWhisper();

  if (!fs.existsSync(videoPath)) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 文件不存在：${videoPath}`,
        },
      ],
    };
  }

  if (!hasFFmpeg) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 需要安装 FFmpeg

安装方法:
1. winget install ffmpeg
2. 或访问 https://ffmpeg.org/download.html`,
        },
      ],
    };
  }

  if (!whisperInfo.available) {
    return {
      content: [
        {
          type: 'text',
          text: `## 🎤 视频转文字

### 需要安装 Whisper 或 faster-whisper

**推荐使用 faster-whisper（速度提升3-5倍，支持GPU加速）:**

\`\`\`bash
# 安装 faster-whisper (推荐!)
pip install faster-whisper

# 或安装普通 Whisper
pip install openai-whisper
\`\`\`

**faster-whisper 模型说明:**
- **tiny-int8**: 最快，INT8量化 (约 40MB) ← 推荐
- **base-int8**: 快速，INT8量化 (约 120MB)
- **small-int8**: 平衡 (约 400MB)

**普通 Whisper 模型:**
- tiny/base/small/medium/large (越大越慢越准确)

**使用方式:**
\`\`\`bash
# 使用 faster-whisper (在模型名加前缀 faster-)
python -c "from faster_whisper import WhisperModel; model = WhisperModel('tiny-int8', compute_type='int8'); segments, _ = model.transcribe('${videoPath.replace(/\\/g, '\\\\')}', language='${language}'); [print(seg.text) for seg in segments]"

# 或使用普通 whisper CLI
whisper "${videoPath}" --language ${language} --model ${model}
\`\`\``,
        },
      ],
    };
  }

  // 检查缓存
  const cacheKey = `transcript_${language}_${model}`;
  if (useCache) {
    const cached = readCache(videoPath, cacheKey);
    if (cached) {
      return {
        content: [
          {
            type: 'text',
            text: `## 🎤 语音识别结果 (已缓存)

**视频文件:** ${path.basename(videoPath)}
**语言:** ${language}
**模型:** ${model}
**识别长度:** ${cached.length} 字符

---

${cached.substring(0, 4000)}${cached.length > 4000 ? '...' : ''}

---

💡 如需重新转写，请设置 use_cache=false`,
          },
        ],
      };
    }
  }

  try {
    const outputDir = path.dirname(videoPath);
    const txtFile = videoPath.replace(/\.[^.]+$/, '.txt');

    console.error(`正在转写: ${videoPath}`);
    console.error(`语言：${language}, 模型：${model}, 引擎：${whisperInfo.type}`);

    let content = '';

    // 使用 faster-whisper (更快)
    if (whisperInfo.type === 'faster-whisper') {
      content = await transcribeWithFasterWhisper(videoPath, language, model);
    } else {
      // 使用普通 whisper CLI
      content = await transcribeWithWhisperCLI(videoPath, language, model);
    }

    // 写入缓存
    if (useCache && content.length > 0) {
      writeCache(videoPath, cacheKey, content);
    }

    return {
      content: [
        {
          type: 'text',
          text: `## 🎤 语音识别结果

**视频文件:** ${path.basename(videoPath)}
**语言:** ${language}
**模型:** ${model}
**引擎:** ${whisperInfo.type}
**识别长度:** ${content.length} 字符

---

${content.substring(0, 4000)}${content.length > 4000 ? '...' : ''}

---

**完整文本文件:** ${txtFile}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 语音识别失败：${error.message}

💡 建议:
1. 尝试使用 faster-whisper: pip install faster-whisper
2. 视频文件可能损坏
3. 语言参数是否正确`,
        },
      ],
    };
  }
}

/**
 * 使用 faster-whisper 转写 (支持GPU加速和INT8量化，速度提升3-5倍)
 */
async function transcribeWithFasterWhisper(videoPath, language, model) {
  // 将模型名转换为 faster-whisper 格式
  let computeType = 'int8'; // 默认INT8量化加速
  let modelName = model;

  // 如果模型名包含 -int8 后缀，提取出来
  if (model.includes('-int8')) {
    modelName = model.replace('-int8', '');
  } else if (model.includes('faster-')) {
    modelName = model.replace('faster-', '');
  }

  // 构建 Python 命令
  const script = `
from faster_whisper import WhisperModel
import sys

model_size = "${modelName}"
compute_type = "${computeType}"

# 如果是 tiny 或 base，优先用 float16 (更快)
if model_size in ["tiny", "base"]:
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
    except:
        model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
else:
    model = WhisperModel(model_size, device="cpu", compute_type=compute_type)

segments, info = model.transcribe("${videoPath.replace(/\\/g, '\\\\')}", language="${language}", beam_size=5)

print(f"# Language: {info.language} (probability: {info.language_probability:.2f})")
print(f"# Duration: {info.duration:.2f}s")

for segment in segments:
    start_ms = int(segment.start * 1000)
    end_ms = int(segment.end * 1000)
    start_str = f"{start_ms//60000:02d}:{(start_ms%60000)//1000:02d}.{start_ms%1000:03d}"
    end_str = f"{end_ms//60000:02d}:{(end_ms%60000)//1000:02d}.{end_ms%1000:03d}"
    print(f"[{start_str} --> {end_str}] {segment.text}")
`;

  const { stdout } = await execPromise(
    `"${WHISPER_PYTHON}" -c "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
    { timeout: 600000 } // 10分钟超时
  );

  return stdout;
}

/**
 * 使用普通 whisper CLI 转写
 */
async function transcribeWithWhisperCLI(videoPath, language, model) {
  const outputDir = path.dirname(videoPath);

  // whisper CLI 转写
  await execPromise(
    `whisper "${videoPath}" --language ${language} --model ${model} --output_dir "${outputDir}" --output_format txt --verbose False`,
    { timeout: 600000 }
  );

  const txtFile = videoPath.replace(/\.[^.]+$/, '.txt');

  if (fs.existsSync(txtFile)) {
    return fs.readFileSync(txtFile, 'utf-8');
  }

  throw new Error('Whisper 未生成输出文件');
}

/**
 * 提取关键帧 (优化版 - 更快的编码)
 */
async function extractKeyframes(videoPath, interval = 60, outputDir = null) {
  const hasFFmpeg = await checkFFmpeg();

  if (!hasFFmpeg) {
    throw new Error('需要安装 FFmpeg');
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`文件不存在：${videoPath}`);
  }

  const videoDir = path.dirname(videoPath);
  const framesDir = outputDir || path.join(videoDir, 'video_frames');

  // 创建输出目录
  if (!fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  // 清理旧文件
  const existingFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
  existingFiles.forEach(f => {
    try { fs.unlinkSync(path.join(framesDir, f)); } catch (e) {}
  });

  // 提取关键帧 - 使用更快的编码设置
  const pattern = path.join(framesDir, 'frame_%03d.png');

  // 优化: 使用 ppconly 默认编码器，-threads 加快速度
  await execPromise(
    `ffmpeg -i "${videoPath}" -vf "fps=1/${interval}" -c:v mjpeg -q:v 3 -threads 4 "${pattern}" -y 2>nul`
  );

  // 统计生成的帧
  const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));

  return {
    count: files.length,
    directory: framesDir,
    files: files.slice(0, 20), // 返回前 20 个文件名
  };
}

/**
 * 提取音频
 */
async function extractAudio(videoPath, outputPath = null, format = 'mp3') {
  const hasFFmpeg = await checkFFmpeg();
  
  if (!hasFFmpeg) {
    throw new Error('需要安装 FFmpeg');
  }

  if (!fs.existsSync(videoPath)) {
    throw new Error(`文件不存在：${videoPath}`);
  }

  if (!outputPath) {
    const videoDir = path.dirname(videoPath);
    const videoName = path.basename(videoPath, path.extname(videoPath));
    outputPath = path.join(videoDir, `${videoName}_audio.${format}`);
  }

  await execPromise(
    `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -ab 192k "${outputPath}" -y 2>nul`
  );

  return {
    path: outputPath,
    size: formatFileSize(fs.statSync(outputPath).size),
  };
}

/**
 * 分析 B 站视频（完整版 - 不下载）
 */
async function analyzeBilibili(url, includeDanmaku = false) {
  // 解析 B23 短链接
  let actualUrl = url;
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      maxRedirects: 0,
      validateStatus: (status) => status === 302 || status === 301
    });
    if (response.headers.location) {
      actualUrl = response.headers.location;
    }
  } catch (e) {}

  // 提取 BV 号或 AV 号
  const bvMatch = actualUrl.match(/\/video\/(BV\w+)/);
  const avMatch = actualUrl.match(/\/video\/av(\d+)/);

  if (!bvMatch && !avMatch) {
    throw new Error('无效的 B 站视频 URL');
  }

  const bvid = bvMatch ? bvMatch[1] : null;
  const aid = avMatch ? parseInt(avMatch[1]) : null;
  const videoId = bvid || `av${aid}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.bilibili.com/',
  };

  try {
    // 1. 获取视频基本信息
    const apiUrl = bvid
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;

    const apiResponse = await axios.get(apiUrl, { headers, timeout: 30000 });
    const data = apiResponse.data;

    if (data.code !== 0 || !data.data) {
      return await analyzeBilibiliFromPage(url, videoId);
    }

    const info = data.data;
    const stat = info.stat || {};

    // 2. 获取字幕信息
    let subtitles = [];
    let subtitleContent = '';
    try {
      const subtitleApiUrl = `https://api.bilibili.com/x/player/v2?bvid=${bvid}&aid=${aid}`;
      const subtitleResponse = await axios.get(subtitleApiUrl, { headers, timeout: 30000 });
      const subtitleData = subtitleResponse.data;

      if (subtitleData.data && subtitleData.data.subtitle) {
        subtitles = subtitleData.data.subtitle.subtitles || [];

        // 获取字幕实际内容
        for (const sub of subtitles) {
          if (sub.subtitle_url) {
            try {
              const subContent = await axios.get(sub.subtitle_url, { timeout: 30000 });
              const subBody = subContent.data;
              // 解析 ASS/SSA 字幕格式
              if (subBody.events) {
                // ASS 格式
                const lines = subBody.events
                  .filter(e => e.Text)
                  .map(e => e.Text.replace(/\\N/g, '\n').replace(/\{[^}]*\}/g, ''))
                  .join('\n');
                sub.content = lines;
              } else if (Array.isArray(subBody)) {
                // JSON 格式
                sub.content = subBody.map(s => s.content).join('\n');
              }
            } catch (e) {
              sub.content = '（无法获取字幕内容）';
            }
          }
        }
      }
    } catch (e) {
      console.error('获取字幕失败:', e.message);
    }

    // 3. 获取弹幕列表
    let danmakuList = [];
    if (includeDanmaku && aid) {
      try {
        const danmakuUrl = `https://api.bilibili.com/x/v1/dm/list.so?oid=${info.cid}`;
        const danmakuResponse = await axios.get(danmakuUrl, {
          headers: { ...headers, 'Accept': 'application/xml' },
          timeout: 30000
        });
        // 解析 XML 弹幕
        const danmakuText = danmakuResponse.data;
        const matches = danmakuText.matchAll(/<d[^>]*>([^<]+)<\/d>/g);
        let count = 0;
        for (const m of matches) {
          danmakuList.push(m[1]);
          count++;
          if (count >= 100) break; // 限制返回100条
        }
      } catch (e) {
        console.error('获取弹幕失败:', e.message);
      }
    }

    // 4. 构建完整输出
    let output = `## 📺 B 站视频分析

**标题:** ${info.title || '未知'}

**UP 主:** ${info.owner?.name || '未知'} (${info.owner?.mid || '未知UID'})

**发布时间:** ${info.pubdate ? new Date(info.pubdate * 1000).toLocaleString('zh-CN') : '未知'}

**播放量:** ${stat.view || 0} | **点赞:** ${stat.like || 0} | **投币:** ${stat.coin || 0} | **收藏:** ${stat.favorite || 0}

**时长:** ${info.duration ? formatDuration(info.duration) : '未知'}

**简介:**
${info.desc || '无简介'}

**视频 ID:** ${videoId}
**分P数:** ${info.pages?.length || 1}

${info.pages && info.pages.length > 1 ? '\n**分P列表:**\n' + info.pages.map((p, i) => `  ${i+1}. ${p.part || p.title}`).join('\n') : ''}
`;

    // 添加字幕信息
    if (subtitles.length > 0) {
      output += `\n**字幕列表:** ${subtitles.length} 个\n`;
      for (const sub of subtitles) {
        output += `\n### 📝 ${sub.lan_doc || sub.lan || '字幕'} ${sub.content ? `(${sub.content.length}字符)` : ''}`;
        if (sub.content) {
          output += `\n${sub.content.substring(0, 2000)}${sub.content.length > 2000 ? '...' : ''}`;
        }
      }
    } else {
      output += `\n**字幕:** 无内嵌字幕`;
    }

    // 添加弹幕信息
    if (danmakuList.length > 0) {
      output += `\n\n**弹幕预览 (前100条):**\n`;
      danmakuList.slice(0, 50).forEach(d => {
        output += `• ${d}\n`;
      });
    }

    output += `\n---\n💡 如需完整语音转文字，请使用 video_to_text 工具下载后分析。`;

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return await analyzeBilibiliFromPage(url, videoId);
  }
}

/**
 * 从网页抓取 B站视频信息（降级方案）
 */
async function analyzeBilibiliFromPage(url, videoId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.bilibili.com/',
  };

  try {
    const response = await axios.get(url, { headers, timeout: 30000 });
    const $ = cheerio.load(response.data);

    const title = $('h1.video-title').text().trim() || $('[property="og:title"]').attr('content') || '';
    const desc = $('.desc').text().trim() || $('[property="og:description"]').attr('content') || '';
    const owner = $('.up-name').text().trim() || '';
    const view = $('.view').text().trim() || '';
    const pubdate = $('.pubdate').text().trim() || '';

    return {
      content: [
        {
          type: 'text',
          text: `## 📺 B 站视频分析

**标题:** ${title}

**UP 主:** ${owner}

**发布时间:** ${pubdate}

**播放量:** ${view}

**简介:**
${desc || '无简介'}

**视频 ID:** ${videoId}

---

💡 如需获取完整字幕和语音转文字，请使用 analyze_online_video 工具。`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`获取视频信息失败：${error.message}`);
  }
}

/**
 * 下载在线视频（B站/YouTube等）
 */
async function downloadOnlineVideo(url, outputDir = null) {
  // 检查 yt-dlp 是否安装
  let hasYtDlp = false;
  try {
    await execPromise('yt-dlp --version');
    hasYtDlp = true;
  } catch (e) {}

  if (!hasYtDlp) {
    // 尝试使用 you-get
    try {
      await execPromise('you-get --version');
      // 使用 you-get 下载
      const tempDir = outputDir || path.join(CACHE_DIR, 'downloads');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const { stdout, stderr } = await execPromise(
        `you-get -o "${tempDir}" "${url}"`,
        { timeout: 600000 }
      );
      // 查找下载的文件
      const files = fs.readdirSync(tempDir).filter(f => /\.(mp4|flv|mkv|avi)$/i.test(f));
      if (files.length > 0) {
        return path.join(tempDir, files[0]);
      }
      throw new Error('未找到下载的视频文件');
    } catch (e) {
      throw new Error('需要安装 yt-dlp 或 you-get 来下载在线视频\n安装方法: pip install yt-dlp');
    }
  }

  // 使用 yt-dlp 下载
  const tempDir = outputDir || path.join(CACHE_DIR, 'downloads');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // yt-dlp 下载最佳画质音频+视频
  await execPromise(
    `yt-dlp -f "bv+ba/best" --merge-output-format mp4 -o "${tempDir}/%(title)s.%(ext)s" "${url}"`,
    { timeout: 600000 }
  );

  // 查找下载的文件
  const files = fs.readdirSync(tempDir).filter(f => /\.(mp4|flv|mkv|avi|webm)$/i.test(f));
  if (files.length > 0) {
    // 返回最新修改的文件
    const filePaths = files.map(f => path.join(tempDir, f));
    filePaths.sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime);
    return filePaths[0];
  }

  throw new Error('视频下载失败');
}

/**
 * 分析 YouTube 视频
 */
async function analyzeYoutube(url) {
  const videoIdMatch = url.match(/[?&]v=([^&]+)/) || url.match(/\/watch\/([^?]+)/);
  
  if (!videoIdMatch) {
    throw new Error('无效的 YouTube 视频 URL');
  }

  const videoId = videoIdMatch[1];
  
  // 检查 yt-dlp
  let ytDlpGuide = '';
  try {
    await execPromise('yt-dlp --version');
  } catch (e) {
    ytDlpGuide = `
---

### 📥 安装 yt-dlp (可选)

\`\`\`bash
pip install yt-dlp
\`\`\`

安装后可使用以下命令:

\`\`\`bash
# 列出可用字幕
yt-dlp --list-subs "${url}"

# 下载英文字幕
yt-dlp --write-sub --sub-lang en --skip-download "${url}"

# 下载中文字幕
yt-dlp --write-sub --sub-lang zh-Hans --skip-download "${url}"

# 下载视频和字幕
yt-dlp --write-sub "${url}"
\`\`\`
`;
  }

  return {
    content: [
      {
        type: 'text',
        text: `## 📺 YouTube 视频分析

**视频 ID:** ${videoId}

**URL:** ${url}

---

### 可用功能:

1. **获取视频信息** - 标题、描述、上传者等
2. **提取字幕** - 自动生成的字幕或上传的字幕
3. **下载视频** - 需要安装 yt-dlp

${ytDlpGuide}

---

💡 需要安装 yt-dlp 工具才能获取完整信息。`,
      },
    ],
  };
}

/**
 * 分析在线视频（支持 B站/YouTube）- 下载后完整分析
 */
async function analyzeOnlineVideo(url, options = {}) {
  const {
    extract_metadata = true,
    extract_subtitles = true,
    video_to_text = false,
    language = 'zh',
  } = options;

  const hasFFmpeg = await checkFFmpeg();
  const whisperInfo = await checkWhisper();

  // 检查 yt-dlp 是否可用
  let hasYtDlp = false;
  try {
    await execPromise('yt-dlp --version');
    hasYtDlp = true;
  } catch (e) {}

  // 判断视频平台
  const isBilibili = url.includes('bilibili.com') || url.includes('b23.tv');
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');

  if (!hasYtDlp) {
    return {
      content: [
        {
          type: 'text',
          text: `## 📺 在线视频分析

**URL:** ${url}

### ⚠️ 需要安装 yt-dlp

yt-dlp 是下载在线视频的最佳工具，支持 B站、YouTube 等平台。

**安装方法:**
\`\`\`bash
pip install yt-dlp
\`\`\`

**安装后功能:**
1. 下载视频到本地
2. 提取字幕
3. 语音转文字
4. 获取完整元数据`,
        },
      ],
    };
  }

  try {
    console.error(`正在分析在线视频: ${url}`);

    // 创建临时下载目录
    const tempDir = path.join(CACHE_DIR, 'online_video_' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    // 下载视频
    console.error('正在下载视频...');
    const localPath = await downloadOnlineVideo(url, tempDir);
    console.error(`视频已下载: ${localPath}`);

    // 构建分析结果
    let result = {
      url: url,
      local_path: localPath,
      file: path.basename(localPath),
      size: formatFileSize(fs.statSync(localPath).size),
    };

    // 并行执行分析任务
    const tasks = [];

    if (extract_metadata && hasFFmpeg) {
      tasks.push(
        getVideoMetadata(localPath)
          .then(m => { result.metadata = m; })
          .catch(e => { result.metadata_error = e.message; })
      );
    }

    if (extract_subtitles && hasFFmpeg) {
      tasks.push(
        extractSubtitlesFromFile(localPath)
          .then(s => { result.subtitles = s; })
          .catch(e => { result.subtitles_error = e.message; })
      );
    }

    if (video_to_text && whisperInfo.available) {
      tasks.push(
        videoToText(localPath, language, 'base', true)
          .then(r => {
            // 提取文本内容
            if (r.content && r.content[0] && r.content[0].text) {
              const text = r.content[0].text;
              const match = text.match(/\*\*识别长度:\*\* (\d+)/);
              result.transcript_length = match ? parseInt(match[1]) : 0;
              result.transcript_preview = text.substring(0, 2000);
            }
          })
          .catch(e => { result.transcript_error = e.message; })
      );
    }

    await Promise.all(tasks);

    // 清理临时文件
    try {
      const files = fs.readdirSync(tempDir);
      files.forEach(f => {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
      });
      fs.rmdirSync(tempDir);
    } catch (e) {}

    // 格式化输出
    let output = `## 📺 在线视频分析

**来源:** ${isBilibili ? 'B站' : isYouTube ? 'YouTube' : '在线视频'}
**原始URL:** ${url}
**本地文件:** ${result.file}
**文件大小:** ${result.size}

`;

    if (result.metadata) {
      output += `
### 📊 元数据

**时长:** ${result.metadata.duration}
**比特率:** ${result.metadata.bitrate}
`;
      if (result.metadata.video) {
        output += `**视频:** ${result.metadata.video.codec} | ${result.metadata.video.resolution} | ${result.metadata.video.fps}`;
      }
      if (result.metadata.audio) {
        output += `\n**音频:** ${result.metadata.audio.codec} | ${result.metadata.audio.sample_rate}`;
      }
      output += '\n';
    }

    if (result.subtitles && result.subtitles !== '未找到内嵌字幕流') {
      output += `
### 📝 字幕内容

${result.subtitles.substring(0, 1500)}${result.subtitles.length > 1500 ? '...' : ''}
`;
    }

    if (result.transcript_preview) {
      output += `
### 🎤 语音转文字

${result.transcript_preview}
`;
    }

    if (result.subtitles_error && result.transcript_error) {
      output += `
### ⚠️ 说明

该视频可能没有内嵌字幕，且语音转文字未能自动进行。
建议:
1. 使用 video_to_text 工具手动转写
2. 视频可能需要特殊处理`;
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 在线视频分析失败：${error.message}

请确保:
1. yt-dlp 已安装: pip install yt-dlp
2. 视频链接可访问
3. 网络连接正常`,
        },
      ],
      isError: true,
    };
  }
}

// 辅助函数：格式化文件大小
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 辅助函数：格式化时长
function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 辅助函数：解析 FPS
function parseFps(fpsStr) {
  if (!fpsStr) return 'N/A';
  const parts = fpsStr.split('/');
  if (parts.length === 2) {
    return (parseInt(parts[0]) / parseInt(parts[1])).toFixed(2) + ' fps';
  }
  return fpsStr + ' fps';
}

// 辅助函数：格式化视频分析结果
function formatVideoAnalysis(result) {
  let text = `## 🎬 视频分析结果

**文件名:** ${result.file}
**路径:** ${result.path}
**大小:** ${result.size}
`;

  if (result.metadata) {
    const m = result.metadata;
    text += `
### 📊 元数据

**时长:** ${m.duration}
**比特率:** ${m.bitrate}
`;
    if (m.video) {
      text += `
**视频编码:** ${m.video.codec}
**分辨率:** ${m.video.resolution}
**帧率:** ${m.video.fps}
**像素格式:** ${m.video.pixel_format}
`;
    }
    if (m.audio) {
      text += `
**音频编码:** ${m.audio.codec}
**采样率:** ${m.audio.sample_rate}
**声道数:** ${m.audio.channels}
`;
    }
  }

  if (result.subtitles) {
    text += `
### 📝 字幕内容

${result.subtitles.substring(0, 2000)}...
`;
  }

  if (result.frames) {
    text += `
### 🖼️ 关键帧

**提取数量:** ${result.frames.count}
**保存位置:** ${result.frames.directory}
`;
  }

  if (result.audio) {
    text += `
### 🎵 提取音频

**文件:** ${result.audio}
**大小:** ${result.audio_size || 'N/A'}
`;
  }

  return text;
}

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('视频内容解析 MCP Server Pro (支持 FFmpeg) 已启动');
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
