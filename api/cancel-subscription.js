const { getStripe } = require("./_lib/stripeClient");
const { getAdminDb, requireAuth } = require("./_lib/firebaseAdmin");

// Downgrading from a paid plan back to Free does NOT happen immediately:
// we mark the subscription to cancel at the end of the current billing
// period (the plan the user already paid for keeps working until then), and
// let the `customer.subscription.deleted` webhook event flip Firestore back
// to "free" once that period actually ends. A user can also call this again
// with `resume: true` before the period ends to undo the scheduled
// cancellation and keep their subscription going.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await requireAuth(req);
    const resume = !!(req.body && req.body.resume);

    const db = getAdminDb();
    const userRef = db.collection("users").doc(decoded.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    if (!userData.stripeSubscriptionId) {
      res.status(400).json({ error: "No active subscription found for this account" });
      return;
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: !resume,
    });

    await userRef.set(
      {
        planCancelAtPeriodEnd: !resume,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
      },
      { merge: true }
    );

    res.status(200).json({
      cancelAtPeriodEnd: !resume,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
    });
  } catch (err) {
    console.error("cancel-subscription error", err);
    res.status(err.statusCode || 500).json({ error: err.message || "Internal error" });
  }
};
