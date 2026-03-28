FROM python:3.10-slim

# 设置工作目录
WORKDIR /app

# 设置时区为上海，方便查看日志
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制程序代码
COPY . .

# 定义数据卷挂载点（用于保存 session）
VOLUME /app/session

# 启动命令
CMD ["python", "main.py"]
