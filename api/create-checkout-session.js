const { getStripe } = require("./_lib/stripeClient");
const { getAdminDb, requireAuth } = require("./_lib/firebaseAdmin");
const { priceIdForPlan } = require("./_lib/plans");

// Creates a Stripe Checkout Session (subscription mode) for the signed-in
// user to upgrade to "pro" or "business", and returns the hosted Checkout
// URL for the client to redirect to. The actual plan change is only ever
// written to Firestore later, by the webhook, once Stripe confirms payment
// succeeded — never directly from this endpoint.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await requireAuth(req);
    const { plan } = req.body || {};

    const priceId = priceIdForPlan(plan);
    if (!priceId) {
      res.status(400).json({ error: `Unknown or unconfigured plan: ${plan}` });
      return;
    }

    const stripe = getStripe();
    const db = getAdminDb();
    const userRef = db.collection("users").doc(decoded.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // Reuse an existing Stripe Customer for this user if we already created
    // one (e.g. from a previous checkout attempt or plan change), otherwise
    // let Stripe Checkout create one automatically and we save it via the
    // webhook once the session completes.
    let customerId = userData.stripeCustomerId || null;
    if (customerId) {
      // Make sure it still exists / hasn't been deleted in the Stripe dashboard.
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if (existing.deleted) customerId = null;
      } catch (err) {
        customerId = null;
      }
    }

    const origin =
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : "https://kanban.dubdesign.net");

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId || undefined,
      customer_email: customerId ? undefined : decoded.email || undefined,
      client_reference_id: decoded.uid,
      metadata: { firebaseUID: decoded.uid, plan },
      subscription_data: {
        metadata: { firebaseUID: decoded.uid, plan },
      },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error", err);
    res.status(err.statusCode || 500).json({ error: err.message || "Internal error" });
  }
};
