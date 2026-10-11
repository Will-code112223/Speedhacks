// Scripted example: model-free, known-answer connector calls for synthetic missions.
// Replace the selection/planning below with your agent. No Worlds client is required.
// The runner supplies only public task text and twin credentials, never grader keys.
const templateId = "customer-desk";
const scripts = {
  "duplicate-charge": [
    {
      "method": "GET",
      "path": "/api/v2/tickets/1.json"
    },
    {
      "method": "GET",
      "path": "/v1/invoices/in_desk_ada"
    },
    {
      "method": "GET",
      "path": "/v1/charges",
      "params": {
        "customer": "cus_desk_ada",
        "limit": 100
      }
    },
    {
      "method": "POST",
      "path": "/v1/refunds",
      "params": {
        "charge": "ch_desk_duplicate",
        "amount": 2900,
        "reason": "duplicate"
      }
    },
    {
      "method": "PUT",
      "path": "/api/v2/tickets/1.json",
      "params": {
        "ticket": {
          "status": "solved",
          "tags": [
            "billing",
            "refunded"
          ],
          "comment": {
            "body": "Refunded $29.00 USD for duplicate charge ch_desk_duplicate. The original payment remains unchanged.",
            "public": true
          }
        }
      }
    }
  ],
  "renewal-cancellation": [
    {
      "method": "GET",
      "path": "/api/v2/tickets/2.json"
    },
    {
      "method": "GET",
      "path": "/v1/subscriptions/sub_desk_jules"
    },
    {
      "method": "POST",
      "path": "/v1/subscriptions/sub_desk_jules",
      "params": {
        "cancel_at_period_end": true
      }
    },
    {
      "method": "PUT",
      "path": "/api/v2/tickets/2.json",
      "params": {
        "ticket": {
          "status": "solved",
          "tags": [
            "billing",
            "cancellation_scheduled"
          ],
          "comment": {
            "body": "Subscription sub_desk_jules will cancel at renewal. Your current paid period stays available until then.",
            "public": true
          }
        }
      }
    }
  ],
  "ambiguous-identity": [
    {
      "method": "GET",
      "path": "/api/v2/tickets/3.json"
    },
    {
      "method": "GET",
      "path": "/v1/customers",
      "params": {
        "email": "alex@example.test",
        "limit": 100
      }
    },
    {
      "method": "PUT",
      "path": "/api/v2/tickets/3.json",
      "params": {
        "ticket": {
          "status": "hold",
          "tags": [
            "billing",
            "identity_review"
          ],
          "comment": {
            "body": "Ambiguous identity: cus_desk_alex_personal and cus_desk_alex_studio match the email. Billing is unchanged; review after an invoice ID is supplied.",
            "public": false
          }
        }
      }
    },
    {
      "method": "PUT",
      "path": "/api/v2/tickets/3.json",
      "params": {
        "ticket": {
          "comment": {
            "body": "Could you provide an invoice ID so we can identify the correct account before considering a refund?",
            "public": true
          }
        }
      }
    }
  ]
}
;
const task = JSON.parse(process.env.WORLDS_TASK_JSON || "null");
if (!task || task.templateId !== templateId || !Object.hasOwn(scripts, task.mission?.id)) {
  throw new Error("Run this agent with worlds starters run customer-desk --mission <id> -- node agent.mjs");
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
