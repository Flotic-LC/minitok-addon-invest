// Test WTS UTK refresh with current (expired) token
const wts = require("/opt/minitok/addons/invest/src/toss_wts_exchange.js");

(async () => {
  console.log("=== 1. refreshUtk with expired token ===");
  try {
    const ok = await wts.refreshUtk(wts.authState);
    console.log("refreshUtk result:", ok);
  } catch (e) { console.log("refreshUtk threw:", e.message); }

  console.log("=== 2. try authenticated GET after refresh attempt ===");
  try {
    const r = await wts.getCurrentQuoteForSell(wts.authState);
    console.log("GET status:", r.status, JSON.stringify(r.body).substring(0, 200));
  } catch (e) { console.log("GET threw:", e.message); }

  console.log("=== 3. base rate (no auth) ===");
  try {
    const r = await wts.getBaseExchangeRate();
    console.log("base rate status:", r.status, JSON.stringify(r.body).substring(0, 200));
  } catch (e) { console.log("base rate threw:", e.message); }
})();