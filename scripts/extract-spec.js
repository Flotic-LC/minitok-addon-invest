"use strict";
const fs = require("node:fs");
const spec = JSON.parse(fs.readFileSync(process.env.TEMP + "/toss-openapi.json", "utf8"));
const sc = spec.components.schemas;
function pick(n) {
  const x = sc[n];
  if (!x) return n + ": NOT FOUND";
  const props = x.properties
    ? Object.fromEntries(Object.entries(x.properties).map(([k, v]) => [k, v.type || v.enum || v["allOf"] ? (v.type || v.enum || "allOf") : v["$ref"] || "?"]))
    : null;
  const out = { type: x.type, required: x.required, properties: props };
  if (x.enum) out.enum = x.enum;
  if (x.items) out.items = x.items.type || x.items["$ref"];
  return JSON.stringify(out, null, 1);
}
for (const name of ["OrderStatus", "OrderResponse", "PaginatedOrderResponse", "ConditionalOrderCreateResponse", "PaginatedConditionalOrderResponse", "ConditionalOrder", "ConditionalOrderStatus", "ApiResponse"]) {
  console.log("=== " + name + " ===");
  console.log(pick(name));
}
// --- round 2: parameters & conditional detail ---
const ordersGet = spec.paths["/api/v1/orders"].get;
console.log("=== GET /api/v1/orders params ===");
console.log(JSON.stringify(ordersGet.parameters, null, 1).slice(0, 1500));
console.log("=== GET /api/v1/orders 200 ===");
console.log(JSON.stringify(ordersGet.responses["200"].content["application/json"].schema, null, 1).slice(0, 600));

const condDetailPath = spec.paths["/api/v1/conditional-orders/{conditionalOrderId}"];
console.log("=== GET conditional detail 200 ===");
console.log(JSON.stringify(condDetailPath.get.responses["200"].content["application/json"].schema, null, 1).slice(0, 800));

// find the schema used for conditional order list items
const condListSchema = spec.paths["/api/v1/conditional-orders"].get.responses["200"].content["application/json"].schema;
console.log("=== GET conditional list 200 ===");
console.log(JSON.stringify(condListSchema, null, 1).slice(0, 800));

// conditional order item schema names
const itemRef = JSON.stringify(condListSchema).match(/schemas\/(\w*Conditional\w*)/g);
console.log("=== conditional refs in list ===", itemRef);
for (const n of new Set((itemRef || []).map(r => r.split("/")[1]))) {
  console.log("--- " + n + " ---");
  console.log(pick(n));
}

