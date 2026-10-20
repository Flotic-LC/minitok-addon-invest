"""
Minitok Macro Data Sidecar
FastAPI server providing macroeconomic context for trading decisions.

Features:
- 5-minute background refresh of macro context (asyncio task)
- File-based cache fallback when upstream APIs fail
- Explainable regime classification with reasons list
- Alpha Engine: 20-factor technical signals + GMM regime detection
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
import logging

from data_engine import MacroDataProvider
from alpha_engine import AlphaEngine

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 300  # [P6] 5 minutes (FRED data updates daily, no need for frequent refresh)
BACKGROUND_REFRESH_SECONDS = 300  # 5 minutes
CACHE_DIR = os.getenv("CACHE_DIR", "data/cache")

macro_provider = MacroDataProvider(cache_dir=CACHE_DIR)
alpha_engine = AlphaEngine()

_response_cache: Dict[str, Any] = {}
_response_cache_ts: float = 0


async def _background_refresh_loop():
    logger.info(f"Background refresh started (interval={BACKGROUND_REFRESH_SECONDS}s)")
    while True:
        try:
            await asyncio.sleep(BACKGROUND_REFRESH_SECONDS)
            logger.info("Background refresh tick")
            loop = asyncio.get_event_loop()
            context = await loop.run_in_executor(None, macro_provider.get_regime_context)
            global _response_cache, _response_cache_ts
            _response_cache = context
            _response_cache_ts = time.time()
        except asyncio.CancelledError:
            logger.info("Background refresh cancelled")
            raise
        except Exception as e:
            logger.error(f"Background refresh error: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_background_refresh_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title="Minitok Macro Data Sidecar",
    description="Macroeconomic context + alpha factor signals",
    version="1.4.0",
    lifespan=lifespan,
)


class MacroContextResponse(BaseModel):
    regime: str
    interest_rate_trend: str
    volatility_regime: str
    usd_krw_trend: str
    risk_appetite: str
    timestamp: str
    cached: bool = False
    reasons: Optional[List[str]] = None
    indicators: Optional[Dict[str, Any]] = None


class AlphaBatchRequest(BaseModel):
    symbols: List[str]


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "minitok-macro-sidecar",
        "version": "1.4.0",
        "timestamp": time.time(),
        "cache_dir": CACHE_DIR,
    }


@app.get("/api/v1/macro-context", response_model=MacroContextResponse)
async def get_macro_context():
    global _response_cache, _response_cache_ts
    now = time.time()
    if _response_cache and (now - _response_cache_ts) < CACHE_TTL_SECONDS:
        logger.info("Returning cached macro context")
        cached_response = dict(_response_cache)
        cached_response["cached"] = True
        return cached_response

    try:
        logger.info("Fetching fresh macro context")
        loop = asyncio.get_event_loop()
        context = await loop.run_in_executor(None, macro_provider.get_regime_context)
        _response_cache = context
        _response_cache_ts = now
        return context
    except Exception as e:
        logger.error(f"Error fetching macro context: {e}", exc_info=True)
        return MacroContextResponse(
            regime="unknown", interest_rate_trend="unknown",
            volatility_regime="unknown", usd_krw_trend="unknown",
            risk_appetite="neutral",
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            cached=False, reasons=[f"Error: {e}"],
        )


# --- Portfolio Optimizer endpoints (v1.4.0) ---
from portfolio_optimizer import PositionSizer

position_sizer = PositionSizer(max_single_weight=0.30)


class HoldingItem(BaseModel):
    symbol: str
    weight: float = 0.0
    pnl: float = 0.0


class PositionSizeRequest(BaseModel):
    symbol: str
    action: str
    currentPortfolio: List[HoldingItem] = []
    macro_regime: Optional[str] = None


class WeightsRequest(BaseModel):
    holdings: List[HoldingItem] = []
    macro_regime: Optional[str] = None


def _portfolio_regime_fallback() -> str:
    """Best-effort regime from macro-context when caller omits it."""
    try:
        ctx = macro_provider.get_regime_context()
        if isinstance(ctx, dict) and ctx.get("regime"):
            return str(ctx.get("regime"))
    except Exception:
        pass
    return "neutral"


@app.post("/api/v1/position-size")
async def position_size(request: PositionSizeRequest):
    """
    Approve/block a proposed trade and suggest an optimal weight.
    Runs regime-aware optimization (RP/BL/MV) over the held universe.
    """
    try:
        regime = request.macro_regime or _portfolio_regime_fallback()
        holdings = [h.dict() for h in request.currentPortfolio]
        logger.info(f"position-size: {request.symbol} {request.action} regime={regime} n_holdings={len(holdings)}")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: position_sizer.evaluate_position(
                request.symbol, request.action, holdings, macro_regime=regime
            ),
        )
        return result
    except Exception as e:
        logger.error(f"position-size error: {e}", exc_info=True)
        # Fail-open: do not block trading on optimizer errors
        return {"approved": True, "reason": f"optimizer_error_failopen: {e}", "suggested_weight": None}


@app.post("/api/v1/portfolio/weights")
async def portfolio_weights(request: WeightsRequest):
    """Compute optimal weights for a universe under the current regime."""
    try:
        regime = request.macro_regime or _portfolio_regime_fallback()
        holdings = [h.dict() for h in request.holdings]
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: position_sizer.calculate_weights(holdings, macro_regime=regime)
        )
        return result
    except Exception as e:
        logger.error(f"portfolio/weights error: {e}", exc_info=True)
        return {"error": str(e)}


@app.get("/api/v1/portfolio/models")
async def portfolio_models():
    """List available optimization models and regime mapping."""
    return {
        "models": ["RP", "BL", "MV"],
        "regime_mapping": {
            "volatile": "defensive/RP+bond_tilt",
            "trending_down": "defensive/RP+bond_tilt",
            "trending_up": "aggressive/BL+growth_view",
            "sideways": "neutral/RP",
        },
        "max_single_weight": position_sizer.max_single_weight,
        "riskfolio_available": True,
    }
# --- Attribution Analyzer endpoints (v1.4.0) ---
from attribution_analyzer import AttributionAnalyzer

attribution_analyzer = AttributionAnalyzer(cache_dir=CACHE_DIR)
position_sizer.set_attribution_analyzer(attribution_analyzer)


class AttributionFillRequest(BaseModel):
    symbol: str
    pnl: float
    strategy: Optional[str] = None
    timestamp: Optional[float] = None


class AttributionReportRequest(BaseModel):
    bySymbol: Dict[str, Any] = {}
    byStrategy: Dict[str, Any] = {}
    totalPnl: float = 0.0
    totalFills: int = 0


@app.post("/api/v1/attribution/update")
async def attribution_update(request: AttributionFillRequest):
    """Ingest a single realized PnL fill from the runner's R-3 attribution engine."""
    try:
        return attribution_analyzer.record_fill(
            request.symbol, request.pnl, strategy=request.strategy, timestamp=request.timestamp
        )
    except Exception as e:
        logger.error(f"attribution/update error: {e}", exc_info=True)
        return {"ok": False, "reason": str(e)}


@app.post("/api/v1/attribution/report")
async def attribution_report_ingest(request: AttributionReportRequest):
    """Bulk-ingest an aggregated attributionEngine.report() payload."""
    try:
        return attribution_analyzer.record_report(request.dict())
    except Exception as e:
        logger.error(f"attribution/report error: {e}", exc_info=True)
        return {"ok": False, "reason": str(e)}


@app.get("/api/v1/attribution/summary")
async def attribution_summary():
    """Per-symbol Sharpe ratio and PnL contribution."""
    return attribution_analyzer.summary()


@app.get("/api/v1/attribution/sharpe/{symbol}")
async def attribution_sharpe(symbol: str, lookback_days: int = 90):
    """Sharpe-like ratio for one symbol from realized fills."""
    return attribution_analyzer.get_symbol_sharpe(symbol, lookback_days=lookback_days)


@app.get("/api/v1/attribution/strategy/{strategy_name}")
async def attribution_strategy(strategy_name: str):
    """Aggregate performance for one strategy."""
    return attribution_analyzer.get_strategy_performance(strategy_name)


@app.get("/api/v1/portfolio/recommendations")
async def portfolio_recommendations():
    """Auto weight-adjustment proposals derived from attribution Sharpe ratios."""
    return attribution_analyzer.recommend_adjustments()
# --- Sentiment Engine endpoints (v1.4.0) ---
from sentiment_engine import FinancialSentiment

sentiment_engine = FinancialSentiment(cache_dir=CACHE_DIR)


@app.get("/api/v1/sentiment/{symbol}")
async def get_sentiment(symbol: str, force: bool = False):
    """Aggregate news sentiment for a symbol (FinGPT-style keyword scoring)."""
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, sentiment_engine.get_sentiment, symbol, force)
    except Exception as e:
        logger.error(f"sentiment error for {symbol}: {e}", exc_info=True)
        return {
            "symbol": symbol, "avg_sentiment": 0.0, "news_count": 0,
            "key_events": [], "confidence": 0.0, "label": "중립",
            "method": "keyword", "error": str(e),
        }


# --- Backtest Sandbox endpoints (v1.4.0) ---
from backtest import StrategyValidator, STRATEGY_PARAMS

strategy_validator = StrategyValidator(cache_dir=CACHE_DIR)


class BacktestValidateRequest(BaseModel):
    param: str
    old: float
    new: float


@app.post("/api/v1/backtest-validate")
async def backtest_validate(request: BacktestValidateRequest):
    """Validate a proposed R-5 param change via backtest. Fail-open to reject."""
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, strategy_validator.validate_change,
            request.param, request.old, request.new,
        )
    except Exception as e:
        logger.error(f"backtest-validate error: {e}", exc_info=True)
        return {"approved": False, "param": request.param, "reason": f"validator error: {e}"}


@app.get("/api/v1/backtest/params")
async def backtest_params():
    """List tunable strategy params and defaults."""
    return {"params": STRATEGY_PARAMS, "lookback_months": int(os.getenv("BACKTEST_LOOKBACK_MONTHS", "6"))}


# --- Alpha Validator endpoints (v1.3.0) ---
from alpha_validator import AlphaValidator, FACTOR_NAMES

alpha_validator = AlphaValidator()


class ValidateBatchRequest(BaseModel):
    symbols: List[str]
    horizon: int = 1
    lookback_days: int = 252


@app.get("/api/v1/alpha/performance/{factor_name}")
async def get_factor_performance(factor_name: str, symbol: str = "005930", horizon: int = 1, lookback_days: int = 252):
    """
    IC, IR, p-value for one factor on one symbol.
    IC = Spearman corr(factor[t], forward_return[t..t+horizon]).
    """
    if factor_name not in FACTOR_NAMES:
        return {"error": f"unknown factor '{factor_name}'", "known_factors": FACTOR_NAMES}
    try:
        logger.info(f"Factor performance: {factor_name} on {symbol} (h={horizon}, lb={lookback_days})")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: alpha_validator.calculate_ic(symbol, factor_name, lookback_days=lookback_days, horizon=horizon),
        )
        return result
    except ValueError as e:
        return {"error": str(e), "factor": factor_name, "symbol": symbol}
    except Exception as e:
        logger.error(f"Validator error {factor_name}/{symbol}: {e}", exc_info=True)
        return {"error": str(e), "factor": factor_name, "symbol": symbol}


@app.get("/api/v1/alpha/factors")
async def list_factors():
    """List all computable factor names."""
    return {"factors": FACTOR_NAMES, "count": len(FACTOR_NAMES)}


@app.post("/api/v1/alpha/validate")
async def validate_factors(request: ValidateBatchRequest):
    """Score every factor across every symbol; aggregate mean IC + pct significant."""
    try:
        logger.info(f"Validate request: {len(request.symbols)} symbols, horizon={request.horizon}")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: alpha_validator.validate_all(request.symbols, horizon=request.horizon, lookback_days=request.lookback_days),
        )
        return result
    except Exception as e:
        logger.error(f"Validate batch error: {e}", exc_info=True)
        return {"error": str(e)}


@app.post("/api/v1/alpha/correlation")
async def factor_correlation(request: ValidateBatchRequest):
    """Cross-factor Spearman correlation matrix (multicollinearity check)."""
    try:
        logger.info(f"Factor correlation: {len(request.symbols)} symbols")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, alpha_validator.factor_correlation_matrix, request.symbols)
        return result
    except Exception as e:
        logger.error(f"Correlation error: {e}", exc_info=True)
        return {"error": str(e)}
@app.get("/api/v1/alpha/{symbol}")
async def get_alpha_signals(symbol: str):
    """Compute 20 alpha factors + market regime for a symbol."""
    try:
        logger.info(f"Alpha signals request: {symbol}")
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, alpha_engine.compute_signals, symbol)
        result["summary"] = alpha_engine.summarize_for_llm(result)
        return result
    except ValueError as e:
        return {"error": str(e), "symbol": symbol}
    except Exception as e:
        logger.error(f"Alpha engine error for {symbol}: {e}", exc_info=True)
        return {"error": str(e), "symbol": symbol}


@app.post("/api/v1/alpha/batch")
async def get_alpha_batch(request: AlphaBatchRequest):
    """Compute alpha signals for multiple symbols."""
    try:
        logger.info(f"Alpha batch request: {request.symbols}")
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, alpha_engine.compute_batch, request.symbols)
        for sym, res in results.items():
            if "error" not in res:
                res["summary"] = alpha_engine.summarize_for_llm(res)
        return {"results": results, "count": len(results)}
    except Exception as e:
        logger.error(f"Alpha batch error: {e}", exc_info=True)
        return {"error": str(e)}



@app.post("/api/v1/rebalance")
async def rebalance_portfolio(request: dict):
    """Generate rebalance plan: compare current vs target weights."""
    try:
        positions = request.get("positions", [])
        cash_krw = request.get("cashKrw", 0)
        macro_regime = request.get("macro_regime")

        if not positions:
            return {"trades": [], "reason": "no positions", "cash_krw": cash_krw}

        current_portfolio = {
            "positions": positions,
            "cashKrw": cash_krw,
        }

        plan = await run_in_threadpool(
            lambda: position_sizer.rebalance_plan(current_portfolio, macro_regime)
        )

        logger.info(f"rebalance: {len(plan.get('trades', []))} trades, equity={plan.get('total_equity_krw', 0):,.0f} KRW")
        return plan

    except Exception as e:
        logger.error(f"rebalance error: {e}", exc_info=True)
        return {"trades": [], "error": str(e), "cash_krw": request.get("cashKrw", 0)}

@app.get("/")
async def root():
    return {
        "service": "Minitok Macro Data Sidecar",
        "version": "1.4.0",
        "endpoints": {
            "health": "/health",
            "macro_context": "/api/v1/macro-context",
            "alpha": "/api/v1/alpha/{symbol}",
            "alpha_batch": "/api/v1/alpha/batch",
            "alpha_performance": "/api/v1/alpha/performance/{factor_name}",
            "alpha_validate": "/api/v1/alpha/validate",
            "alpha_correlation": "/api/v1/alpha/correlation",
            "alpha_factors": "/api/v1/alpha/factors",
            "position_size": "/api/v1/position-size",
            "rebalance": "/api/v1/rebalance",
            "portfolio_weights": "/api/v1/portfolio/weights",
            "portfolio_models": "/api/v1/portfolio/models",
            "portfolio_recommendations": "/api/v1/portfolio/recommendations",
            "attribution_update": "/api/v1/attribution/update",
            "attribution_summary": "/api/v1/attribution/summary",
            "attribution_sharpe": "/api/v1/attribution/sharpe/{symbol}",
            "attribution_strategy": "/api/v1/attribution/strategy/{strategy_name}",
            "sentiment": "/api/v1/sentiment/{symbol}",
            "backtest_validate": "/api/v1/backtest-validate",
            "backtest_params": "/api/v1/backtest/params",
        },
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
        "background_refresh_seconds": BACKGROUND_REFRESH_SECONDS,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8471"))
    uvicorn.run(app, host="0.0.0.0", port=port)