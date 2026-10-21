#!/usr/bin/env python3
import io

path = "runner.js"
s = io.open(path, encoding="utf-8").read()
orig = s

# cash-rescue mode: treat USD buying power as usable cash so it doesn't fire spuriously
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

# held-sweep log line: report both pools
old8 = '''console.log("[held-sweep] Reviewed " + reviewed + "/" + positions.length + " positions, cashKrw=" + Math.round(cashKrw) + ", equityKrw=" + Math.round(totalEquity) + ", rescue=" + cashRescueMode + ", fxUSD=" + cachedFxRates.FX_USD_KRW);'''
new8 = '''console.log("[held-sweep] Reviewed " + reviewed + "/" + positions.length + " positions, cashKrw=" + Math.round(cashKrw) + ", cashUsd=" + cashUsd.toFixed(2) + ", totalCashKrw=" + Math.round(totalCashKrw) + ", equityKrw=" + Math.round(totalEquity) + ", rescue=" + cashRescueMode + ", fxUSD=" + cachedFxRates.FX_USD_KRW);'''
assert old8 in s, "ANCHOR8 missing"
s = s.replace(old8, new8)

assert s != orig
io.open(path, "w", encoding="utf-8", newline="\n").write(s)
print("PATCHED OK")