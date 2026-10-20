FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py data_engine.py cache.py alpha_engine.py alpha_validator.py portfolio_optimizer.py attribution_analyzer.py sentiment_engine.py backtest.py ./
COPY providers/ ./providers/

# Create cache directory (volume will be mounted here)
RUN mkdir -p /app/data/cache

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:8471/health', timeout=2)" || exit 1

# Run FastAPI with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8471", "--log-level", "info"]
