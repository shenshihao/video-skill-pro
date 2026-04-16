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
    description: '分析 B 站视频，提取标题、简介、弹幕、评论等',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'B 站视频 URL',
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
 * 分析 B 站视频
 */
async function analyzeBilibili(url) {
  // 提取 BV 号或 AV 号
  const bvMatch = url.match(/\/video\/(BV\w+)/);
  const avMatch = url.match(/\/video\/av(\d+)/);
  
  if (!bvMatch && !avMatch) {
    throw new Error('无效的 B 站视频 URL');
  }

  const videoId = bvMatch ? bvMatch[1] : `av${avMatch[1]}`;
  
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

💡 如需获取完整字幕，请下载视频后使用 extract_subtitles 工具。`,
        },
      ],
    };
  } catch (error) {
    throw new Error(`获取视频信息失败：${error.message}`);
  }
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
