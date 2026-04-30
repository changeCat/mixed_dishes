FROM python:3.10-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

RUN pip install --no-cache-dir curl_cffi

COPY chatgpt_register.py ./
COPY config.json ./

CMD ["python", "chatgpt_register.py"]
