#!/usr/bin/env python3
import io, sys

path = "runner.js"
s = io.open(path, encoding="utf-8").read()
orig = s

# 1) Add USD buying-power fetch to Promise.all
old1 = '''      const [holdingsResp, bpResp, ordersResp] = await Promise.all([
        getHoldings(token, TOSS_ACCOUNT_SEQ),
        getBuyingPower(token, TOSS_ACCOUNT_SEQ, "KRW"),
        getOrders(token, TOSS_ACCOUNT_SEQ, "OPEN"),
      ]);'''
new1 = '''      const [holdingsResp, bpResp, bpUsdResp, ordersResp] = await Promise.all([
        getHoldings(token, TOSS_ACCOUNT_SEQ),
        getBuyingPower(token, TOSS_ACCOUNT_SEQ, "KRW"),
        getBuyingPower(token, TOSS_ACCOUNT_SEQ, "USD"),
        getOrders(token, TOSS_ACCOUNT_SEQ, "OPEN"),
      ]);'''
assert old1 in s, "ANCHOR1 missing"
s = s.replace(old1, new1)

# 2) Add cashUsd to portfolioCache
old2 = '''      portfolioCache = {
        cashKrw: Number(bpResp.body?.cashBuyingPower || 0),'''
new2 = '''      portfolioCache = {
        cashKrw: Number(bpResp.body?.cashBuyingPower || 0),
        cashUsd: Number(bpUsdResp.body?.cashBuyingPower || 0),'''
assert old2 in s, "ANCHOR2 missing"
s = s.replace(old2, new2)

# 3) Add cashUsd to fallback objects
old3 = "cashKrw: 0, positions: [], openOrders: [], fetchedAt: null"
new3 = "cashKrw: 0, cashUsd: 0, positions: [], openOrders: [], fetchedAt: null"
n3 = s.count(old3)
assert n3 == 3, f"ANCHOR3 expected 3 got {n3}"
s = s.replace(old3, new3)

# 4) Add cashUsd to AI payload
old4 = '''    portfolio: {
      cashKrw: portfolio.cashKrw,
      positions: portfolio.positions,
      openOrders: portfolio.openOrders,
      dataAgeSec: dataAgeSec,
    },'''
new4 = '''    portfolio: {
      cashKrw: portfolio.cashKrw,
      cashUsd: (portfolio.cashUsd != null ? portfolio.cashUsd : 0),
      positions: portfolio.positions,
      openOrders: portfolio.openOrders,
      dataAgeSec: dataAgeSec,
    },'''
assert old4 in s, "ANCHOR4 missing"
s = s.replace(old4, new4)

# 5) Payload description: add cashUsd
old5 = "portfolio (cashKrw, positions, openOrders)"
new5 = "portfolio (cashKrw, cashUsd, positions, openOrders)"
assert old5 in s, "ANCHOR5 missing"
s = s.replace(old5, new5)

# 6) Add cashUsd-aware instruction after the cashKrw-near-zero line
old6 = '''  promptLines.push("- When cashKrw is near zero, consider partial SELL of profitable positions to free capital for higher-conviction opportunities.");'''
new6 = old6 + '''
  promptLines.push("- CRITICAL cash rules: cashKrw is KRW-denominated buying power; cashUsd is USD-denominated buying power. They are SEPARATE pools. For US-listed symbols (e.g. QQQ, SPY, NVDA, MSFT), use cashUsd to determine affordability. For KRX symbols, use cashKrw. NEVER report 'zero cash available to buy' for a US symbol when cashUsd > 0. Only treat a US symbol as unaffordable when cashUsd is near zero.");'''
assert old6 in s, "ANCHOR6 missing"
s = s.replace(old6, new6)

# 7) cash-rescue mode: treat USD buying power as usable cash so it doesn't fire spuriously
old7 = '''    var cashKrw = portfolio.cashKrw || 0;
    var totalEquity = computeTotalEquityKrw(portfolio);
    var cashRescueMode = cashKrw < 100000 && (totalEquity > 1000000 || positions.length > 0);'''
new7 = '''    var cashKrw = portfolio.cashKrw || 0;
    var cashUsd = portfolio.cashUsd || 0;
    var fxUsdKrw = cachedFxRates.FX_USD_KRW || 1350;
    var totalCashKrw = cashKrw + cashUsd * fxUsdKrw; // USD is directly usable for US-market buys
    var totalEquity = computeTotalEquityKrw(portfolio);
    var cashRescueMode = totalCashKrw < 100000 && (totalEquity > 1000000 || positions.length > 0);'''
assert old7 in s, "ANCHOR7 missing"
s = s.replace(old7, new7)

# 8) held-sweep log line: report both pools
old8 = '''console.log("[held-sweep] Reviewed " + reviewed + "/" + positions.length + " positions, cashKrw=" + Math.round(cashKrw) + ", equityKrw=" + Math.round(totalEquity) + ", rescue=" + cashRescueMode + ", fxUSD=" + cachedFxRates.FX_USD_KRW);'''
new8 = '''console.log("[held-sweep] Reviewed " + reviewed + "/" + positions.length + " positions, cashKrw=" + Math.round(cashKrw) + ", cashUsd=" + cashUsd.toFixed(2) + ", totalCashKrw=" + Math.round(totalCashKrw) + ", equityKrw=" + Math.round(totalEquity) + ", rescue=" + cashRescueMode + ", fxUSD=" + cachedFxRates.FX_USD_KRW);'''
assert old8 in s, "ANCHOR8 missing"
s = s.replace(old8, new8)

assert s != orig
io.open(path, "w", encoding="utf-8", newline="\n").write(s)
print("PATCHED OK")