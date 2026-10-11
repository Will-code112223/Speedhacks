// Scripted example: model-free, known-answer connector calls for synthetic missions.
// Replace the selection/planning below with your agent. No Worlds client is required.
// The runner supplies only public task text and twin credentials, never grader keys.
const templateId = "digital-shop";
const scripts = {
  "design-kit": [
    {
      "method": "GET",
      "path": "/v1/customers/cus_shop_mira"
    },
    {
      "method": "GET",
      "path": "/v1/products",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "GET",
      "path": "/v1/prices",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoiceitems",
      "params": {
        "customer": "cus_shop_mira",
        "price": "price_shop_icons",
        "quantity": 1
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoiceitems",
      "params": {
        "customer": "cus_shop_mira",
        "price": "price_shop_templates",
        "quantity": 1
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoices",
      "params": {
        "customer": "cus_shop_mira",
        "currency": "usd"
      }
    }
  ],
  "team-licenses": [
    {
      "method": "GET",
      "path": "/v1/customers/cus_shop_mira"
    },
    {
      "method": "GET",
      "path": "/v1/products",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "GET",
      "path": "/v1/prices",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoiceitems",
      "params": {
        "customer": "cus_shop_mira",
        "price": "price_shop_tools",
        "quantity": 3
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoices",
      "params": {
        "customer": "cus_shop_mira",
        "currency": "usd"
      }
    }
  ],
  "audio-bundle": [
    {
      "method": "GET",
      "path": "/v1/customers/cus_shop_mira"
    },
    {
      "method": "GET",
      "path": "/v1/products",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "GET",
      "path": "/v1/prices",
      "params": {
        "limit": 100
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoiceitems",
      "params": {
        "customer": "cus_shop_mira",
        "price": "price_shop_effects",
        "quantity": 1
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoiceitems",
      "params": {
        "customer": "cus_shop_mira",
        "price": "price_shop_music",
        "quantity": 1
      }
    },
    {
      "method": "POST",
      "path": "/v1/invoices",
      "params": {
        "customer": "cus_shop_mira",
        "currency": "usd"
      }
    }
  ]
}
;
const task = JSON.parse(process.env.WORLDS_TASK_JSON || "null");
if (!task || task.templateId !== templateId || !Object.hasOwn(scripts, task.mission?.id)) {
  throw new Error("Run this agent with worlds starters run digital-shop --mission <id> -- node agent.mjs");
}
const baseUrl = process.env.WORLDS_BASE_URL;
const apiKey = process.env.WORLDS_API_KEY;
if (!baseUrl || !apiKey) throw new Error("WORLDS_BASE_URL and WORLDS_API_KEY are required");

// Stripe uses bracket-form encoding. The ticket subset also accepts it.
function encode(value, prefix = "", result = new URLSearchParams()) {
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const name = prefix ? prefix + "[" + key + "]" : key;
    if (child !== null && typeof child === "object") encode(child, name, result);
    else result.append(name, String(child));
  }
  return result;
}

async function call(step, index) {
  const url = new URL(step.path, baseUrl);
  const headers = { authorization: "Bearer " + apiKey };
  const init = { method: step.method, headers };
  const form = encode(step.params || {});
  if (step.method === "GET") url.search = form.toString();
  else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    // Keep this key identical on retries. A new world provides a fresh scope.
    headers["idempotency-key"] = "starter-" + templateId + "-" + task.mission.id + "-" + index;
    init.body = form.toString();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    if (response.ok) return body ? JSON.parse(body) : null;
    if ((response.status === 429 || response.status === 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      continue;
    }
    throw new Error(step.method + " " + step.path + ": HTTP " + response.status + " " + body);
  }
}

// This table is a teaching example, not an AI planner or an outcome grader.
// Your agent can read task.mission.prompt and task.mission.policy, inspect the
// catalog/tickets through call(), then choose its own connector operations.
for (const [index, step] of scripts[task.mission.id].entries()) await call(step, index);
console.log("Scripted example completed for " + task.mission.title + ". Grade the world to check the outcome.");
