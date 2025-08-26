import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// Cloud-hosted Express server for PayPal Checkout (no local install needed)
// Prices: $2.50 (single), $10.50 (five)

const app = express();
app.use(express.json());
app.use(cors());

// ----- CONFIG -----
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET;
// Sandbox: https://api-m.sandbox.paypal.com | Live: https://api-m.paypal.com
const PAYPAL_API_BASE  = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
// Public URL of THIS server (set on Render after first deploy)
const PUBLIC_BASE_URL  = process.env.PUBLIC_BASE_URL || "http://localhost:4242";

// Simple in-memory store (OK for MVP; use DB in production)
const purchases = new Map(); // purchaseId -> { orderId, productType, amount, status }

// Helper: PayPal access token
async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// Helper: get order details
async function getOrder(accessToken, orderId) {
  const r = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Get order error: ${JSON.stringify(j)}`);
  return j;
}

// Helper: capture order
async function captureOrder(accessToken, orderId) {
  const r = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Capture error: ${JSON.stringify(j)}`);
  return j;
}

// Create an order — returns approval URL + purchaseId
app.post("/create-order", async (req, res) => {
  try {
    const { productType } = req.body; // "single" | "five"
    let amount;
    if (productType === "single") amount = "2.50";
    else if (productType === "five") amount = "10.50";
    else return res.status(400).json({ error: "Invalid productType" });

    const purchaseId = uuidv4();
    const accessToken = await getAccessToken();

    const returnUrl = `${PUBLIC_BASE_URL}/payment-success?purchaseId=${purchaseId}`;
    const cancelUrl  = `${PUBLIC_BASE_URL}/payment-cancel?purchaseId=${purchaseId}`;

    const createRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: amount } }],
        application_context: {
          brand_name: "Hole In One Challenge",
          user_action: "PAY_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl
        }
      })
    });
    const order = await createRes.json();
    if (!createRes.ok) return res.status(500).json({ error: order });

    const approveLink = order.links?.find(l => l.rel === "approve")?.href;
    if (!approveLink) return res.status(500).json({ error: "No approve link returned." });

    purchases.set(purchaseId, {
      orderId: order.id,
      productType,
      amount,
      status: "created"
    });

    res.json({ approvalUrl: approveLink, purchaseId, orderId: order.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PayPal redirects here after approval — we CAPTURE and mark paid
app.get("/payment-success", async (req, res) => {
  try {
    const { token, purchaseId } = req.query; // token = PayPal orderId
    const p = purchases.get(purchaseId);
    if (!p) return res.status(400).send("Unknown purchaseId.");
    if (!token || token !== p.orderId) return res.status(400).send("Order mismatch.");

    const accessToken = await getAccessToken();
    const captured = await captureOrder(accessToken, p.orderId);

    const completed = captured.status === "COMPLETED";
    p.status = completed ? "paid" : "pending";
    purchases.set(purchaseId, p);

    res.setHeader("Content-Type", "text/html");
    res.send(`<html><body style="font-family:sans-serif">
      <h2>Payment ${completed ? "Completed ✅" : "Pending ⏳"}</h2>
      <p>You can return to the game. It will unlock automatically.</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send("Server error.");
  }
});

app.get("/payment-cancel", (req, res) => {
  const { purchaseId } = req.query;
  const p = purchases.get(purchaseId);
  if (p) { p.status = "cancelled"; purchases.set(purchaseId, p); }
  res.setHeader("Content-Type", "text/html");
  res.send(`<html><body style="font-family:sans-serif"><h2>Payment Cancelled</h2></body></html>`);
});

// Unity polls here — we also auto-capture if the order is APPROVED but not yet captured
app.get("/order-status", async (req, res) => {
  try {
    const { purchaseId } = req.query;
    const p = purchases.get(purchaseId);
    if (!p) return res.json({ found: false });

    if (p.status !== "paid") {
      const accessToken = await getAccessToken();
      const order = await getOrder(accessToken, p.orderId);

      if (order.status === "COMPLETED") {
        p.status = "paid";
        purchases.set(purchaseId, p);
      } else if (order.status === "APPROVED") {
        // Auto-capture here in case user closed the browser before redirect
        try {
          const cap = await captureOrder(accessToken, p.orderId);
          if (cap.status === "COMPLETED") {
            p.status = "paid";
            purchases.set(purchaseId, p);
          } else {
            p.status = "pending";
          }
        } catch {
          // leave as created/pending
        }
      }
    }

    res.json({
      found: true,
      status: p.status,        // created | pending | paid | cancelled | error
      productType: p.productType,
      orderId: p.orderId,
      amount: p.amount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (req, res) => res.send("Hole In One PayPal server OK"));
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
