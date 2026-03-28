import os
import sys
import logging
import asyncio
import requests
from telethon import TelegramClient, events

# ================= 配置日志 =================
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ================= 读取环境变量 =================
# 必须从环境变量获取，不要硬编码在代码里
try:
    API_ID = int(os.getenv('API_ID'))
    API_HASH = os.getenv('API_HASH')
    BOT_TOKEN = os.getenv('BOT_TOKEN')
    CHANNEL_ID = os.getenv('CHANNEL_ID')  # 可以是 @username 或 id
    
    # 图床配置
    UPLOAD_URL = os.getenv('UPLOAD_URL') # 例如 https://sm.ms/api/v2/upload
    UPLOAD_TOKEN = os.getenv('UPLOAD_TOKEN')
    
    # Session 保存路径 (Docker 挂载目录)
    SESSION_PATH = '/app/session/bot_session'

except TypeError:
    logger.error("❌ 环境变量读取失败！请检查 docker-compose.yml 是否配置正确。")
    sys.exit(1)

# ================= 初始化客户端 =================
# 确保存储 session 的文件夹存在
os.makedirs(os.path.dirname(SESSION_PATH), exist_ok=True)

client = TelegramClient(SESSION_PATH, API_ID, API_HASH)

# ================= 核心功能函数 =================

def upload_image_sync(image_bytes):
    """
    同步上传函数 (将在线程池中运行)
    """
    try:
        # ⚠️ 注意：这里以 SM.MS 图床为例
        # 如果是 Chevereto，字段通常是 'source'
        # 如果是 Imgur，字段通常是 'image'
        files = {
            'smfile': ('telegram_img.jpg', image_bytes, 'image/jpeg')
        }
        
        headers = {
            'Authorization': UPLOAD_TOKEN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PythonBot/1.0'
        }

        # 发起 POST 请求
        response = requests.post(UPLOAD_URL, files=files, headers=headers, timeout=30)
        res_json = response.json()

        # ⚠️ 根据你的图床返回格式修改此处判断逻辑
        # 假设成功返回: {'success': True, 'data': {'url': '...'}}
        if res_json.get('success'):
            return res_json['data']['url']
        elif res_json.get('code') == 'success': # 兼容部分图床
             return res_json['data']['url']
        else:
            logger.error(f"图床返回错误: {res_json}")
            return None

    except Exception as e:
        logger.error(f"上传请求异常: {e}")
        return None

async def process_upload(event, image_bytes):
    """
    异步处理上传逻辑，避免阻塞 Bot
    """
    loop = asyncio.get_running_loop()
    # 在独立线程中运行上传，防止卡住 Bot
    url = await loop.run_in_executor(None, upload_image_sync, image_bytes)
    
    if url:
        logger.info(f"✅ 上传成功 | 来源消息ID: {event.id} | URL: {url}")
        # (可选) 这里可以将 URL 回复给频道，或者存入数据库
        # await event.reply(f"图片已存档: {url}")
    else:
        logger.warning(f"❌ 上传失败 | 来源消息ID: {event.id}")

# ================= 事件监听 =================

# 转换 CHANNEL_ID 类型 (如果是纯数字ID，需要转为 int)
target_entity = int(CHANNEL_ID) if CHANNEL_ID.lstrip('-').isdigit() else CHANNEL_ID

@client.on(events.NewMessage(chats=target_entity))
async def handler(event):
    if event.photo:
        logger.info(f"⬇️ 收到新图片 (MsgID: {event.id})，正在下载...")
        
        try:
            # 下载到内存 (bytes)
            image_bytes = await event.download_media(file=bytes)
            logger.info(f"📦 下载完成 ({len(image_bytes)/1024:.2f} KB)，准备上传...")
            
            # 执行上传
            await process_upload(event, image_bytes)
            
        except Exception as e:
            logger.error(f"处理消息时发生未捕获异常: {e}")

# ================= 启动程序 =================

if __name__ == '__main__':
    logger.info("🚀 Bot 正在启动...")
    logger.info(f"监听目标: {CHANNEL_ID}")
    
    # 启动 Bot
    client.start(bot_token=BOT_TOKEN)
    
    # 保持运行
    client.run_until_disconnected()
