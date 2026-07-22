const { getStripe } = require("./_lib/stripeClient");
const { getAdminDb, requireAuth } = require("./_lib/firebaseAdmin");

// Opens Stripe's hosted Customer Portal, where a user can update their
// payment method, view invoices, switch between Pro/Business (if the portal
// is configured in the Stripe Dashboard to allow it), or cancel outright.
// Used both for the "お支払い情報を管理" link and for switching directly
// between two paid plans (Pro <-> Business), since that involves proration
// logic we'd rather let Stripe's own portal handle than reimplement here.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await requireAuth(req);

    const db = getAdminDb();
    const userRef = db.collection("users").doc(decoded.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    if (!userData.stripeCustomerId) {
      res.status(400).json({ error: "No billing account found for this user yet" });
      return;
    }

    const origin =
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : "https://kanban.dubdesign.net");

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: `${origin}/`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("create-portal-session error", err);
    res.status(err.statusCode || 500).json({ error: err.message || "Internal error" });
  }
};
