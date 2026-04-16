# 🎬 Video Skill Pro - 视频内容解析优化版

支持 FFmpeg 和 Whisper/faster-whisper 的完整视频处理功能。

**版本 3.0.0 优化:**
- ⚡ 支持 faster-whisper (GPU加速/INT8量化，速度提升3-5倍)
- 📦 自动缓存转写结果 (7天有效期)
- 🔄 并行执行多个任务
- 🎯 优化的 FFmpeg 命令

---

## 📦 功能对比

| 功能 | 基础版 | Pro 版 (FFmpeg) | Pro 版 (+Whisper) |
|------|--------|-----------------|-------------------|
| 视频元数据 | ❌ | ✅ | ✅ |
| 提取字幕 | ❌ | ✅ | ✅ |
| 关键帧提取 | ❌ | ✅ | ✅ |
| 音频提取 | ❌ | ✅ | ✅ |
| 语音转文字 | ❌ | ❌ | ✅ (优化版) |
| B 站分析 | ✅ | ✅ | ✅ |
| YouTube 分析 | ✅ | ✅ | ✅ |

---

## 🚀 安装步骤

### 1. 安装基础依赖

双击运行 `install.bat`，或手动运行：

```cmd
cd D:\video-skill-pro
npm install
```

### 2. 安装 FFmpeg（必需）

**方法 1: 使用 winget (推荐)**
```cmd
winget install ffmpeg
```

**方法 2: 使用 chocolatey**
```cmd
choco install ffmpeg
```

**方法 3: 手动安装**
1. 访问：https://ffmpeg.org/download.html
2. 下载 Windows 版本
3. 解压到 `C:\ffmpeg\`
4. 添加 `C:\ffmpeg\bin` 到系统 PATH

### 3. 安装 Whisper（语音转文字 - 推荐 faster-whisper）

**方法 1: faster-whisper (推荐 - 速度提升3-5倍)**
```cmd
pip install faster-whisper

# 可选: 安装 GPU 支持 (如果有 NVIDIA 显卡)
pip install faster-whisper[gpu]
```

**方法 2: 普通 Whisper**
```cmd
pip install openai-whisper
```

**验证安装:**
```cmd
python -c "import faster_whisper; print('faster-whisper OK')"
whisper --version
```

### 4. 配置 Claude Desktop

编辑配置文件：
```
%APPDATA%\Claude\claude_desktop_config.json
```

添加配置：
```json
{
  "mcpServers": {
    "video-pro": {
      "command": "node",
      "args": ["D:\\Operation\\skill\\skills\\video-skill-pro\\server.js"]
    }
  }
}
```

### 5. 重启 Claude Desktop

---

## 💬 使用示例

### 完整视频分析

```
分析这个视频：
D:\Videos\lecture.mp4
```

**返回:**
- 视频元数据（时长、分辨率、编码等）
- 内嵌字幕（如果有）
- 关键帧列表
- 提取的音频文件

---

### 语音转文字（推荐使用 faster-whisper）

```
将这个视频转换为文字：
D:\Videos\lecture.mp4
语言：中文
模型：base
```

**返回:**
- 完整的语音识别文字稿
- TXT 和 SRT 文件路径
- 自动缓存结果（7天内重复调用直接返回缓存）

---

### 提取关键帧

```
从这个视频提取关键帧：
D:\Videos\lecture.mp4
间隔：60 秒
```

**返回:**
- 关键帧图片目录
- 图片数量统计

---

### 提取音频

```
从这个视频提取音频：
D:\Videos\lecture.mp4
格式：mp3
```

**返回:**
- 音频文件路径
- 文件大小

---

### 获取视频元数据

```
获取这个视频的信息：
D:\Videos\lecture.mp4
```

**返回:**
```
时长：9:32
大小：26 MB
比特率：384 kbps
视频编码：h264
分辨率：1280x720
帧率：25.00 fps
音频编码：aac
采样率：44100 Hz
```

---

## 🔧 工具列表

### 需要 FFmpeg

| 工具 | 功能 |
|------|------|
| `analyze_video` | 完整视频分析（元数据 + 字幕 + 关键帧，并行执行） |
| `extract_subtitles` | 提取内嵌字幕 |
| `extract_keyframes` | 提取关键帧图片 |
| `extract_audio` | 提取音频 |
| `get_video_metadata` | 获取视频元数据 |

### 需要 FFmpeg + Whisper/faster-whisper

| 工具 | 功能 |
|------|------|
| `video_to_text` | 语音转文字（支持缓存，faster-whisper加速） |

### 不需要 FFmpeg

| 工具 | 功能 |
|------|------|
| `analyze_bilibili` | B 站视频分析 |
| `analyze_youtube` | YouTube 视频分析 |

---

## ⚡ 性能优化

### 1. faster-whisper (推荐)

比普通 Whisper 快 3-5 倍，支持 GPU 加速和 INT8 量化:

```python
from faster_whisper import WhisperModel
model = WhisperModel('tiny-int8', compute_type='int8')  # INT8 量化加速
segments, _ = model.transcribe('video.mp4', language='zh')
```

### 2. 自动缓存

- 转写结果自动缓存 7 天
- 相同视频重复转写直接返回缓存
- 节省大量时间

### 3. 并行执行

`analyze_video` 同时执行:
- 元数据提取
- 字幕提取
- 关键帧提取
- 音频提取

---

## 📊 Whisper 模型选择

### faster-whisper (推荐)

| 模型 | 大小 | 速度 | 准确度 | 适用场景 |
|------|------|------|--------|----------|
| **tiny-int8** | 40MB | ⚡⚡⚡⚡⚡ | ⭐⭐ | 快速转写 ← **推荐** |
| **base-int8** | 120MB | ⚡⚡⚡⚡ | ⭐⭐⭐ | 日常使用 |
| **small-int8** | 400MB | ⚡⚡⚡ | ⭐⭐⭐⭐ | 高准确度 |

### 普通 Whisper

| 模型 | 大小 | 速度 | 准确度 | 适用场景 |
|------|------|------|--------|----------|
| **tiny** | 50MB | ⚡⚡⚡ | ⭐⭐ | 快速测试 |
| **base** | 150MB | ⚡⚡ | ⭐⭐⭐ | 日常使用 ← 推荐 |
| **small** | 500MB | ⚡ | ⭐⭐⭐⭐ | 高准确度需求 |
| **medium** | 1.5GB | 🐌 | ⭐⭐⭐⭐⭐ | 专业转录 |
| **large** | 3GB | 🐌🐌 | ⭐⭐⭐⭐⭐ | 最高准确度 |

---

## ⚠️ 注意事项

| 事项 | 说明 |
|------|------|
| **FFmpeg 路径** | 确保 ffmpeg.exe 在系统 PATH 中 |
| **Whisper 安装** | 推荐安装 faster-whisper（更快） |
| **视频格式** | 支持 MP4/MKV/AVI/MOV 等常见格式 |
| **缓存位置** | `C:\Users\用户名\AppData\Local\Temp\video_skill_cache` |
| **大文件** | 首次转写需要时间，之后使用缓存 |

---

## 🔍 故障排除

### FFmpeg 未找到

```cmd
# 检查是否安装
where ffmpeg

# 如果未找到，重新安装
winget install ffmpeg
```

### Whisper 未找到

```cmd
# 检查是否安装
python -c "import faster_whisper"
pip install faster-whisper
```

### 字幕提取失败

- 视频可能没有内嵌字幕
- 尝试使用 `video_to_text` 进行语音识别

### 转写太慢

- 安装 faster-whisper: `pip install faster-whisper`
- 使用 tiny-int8 模型代替 base
- 确保使用缓存（默认开启）

---

## 📁 文件结构

```
video-skill-pro/
├── server.js           # 主程序（优化版 v3.0）
├── package.json        # 依赖配置
├── install.bat         # 安装脚本
└── README.md           # 说明文档
```

---

## 🆚 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| 3.0.0 | 2026-04-12 | faster-whisper支持、缓存机制、并行执行 |
| 2.0.0 | 2026-04-11 | FFmpeg支持、完整功能 |
| 1.0.0 | 2026-04-10 | 基础版本 |

---

**创建时间:** 2026-04-11
**版本:** 3.0.0 (优化版)
