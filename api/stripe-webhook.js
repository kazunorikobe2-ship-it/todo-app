const { getStripe } = require("./_lib/stripeClient");
const { getAdminDb } = require("./_lib/firebaseAdmin");
const { planForPriceId } = require("./_lib/plans");
const { syncOwnerPlanForEmail } = require("./_lib/syncOwnerPlan");

// Stripe needs the exact raw request body (not the JSON-parsed version) to
// verify the webhook signature, so we turn off Vercel's automatic body
// parsing for this one function only.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function findUserByCustomerId(db, customerId) {
  const snap = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0];
}

// Applies a plan change (or reversion to free) for one user: updates their
// profile doc AND every project they own, exactly like the client's own
// savePlanForCurrentUser() did before billing was wired up to real payments.
async function applyPlanForCustomer(db, customerId, updates) {
  const userDoc = await findUserByCustomerId(db, customerId);
  if (!userDoc) {
    console.warn("stripe-webhook: no user found for Stripe customer", customerId);
    return;
  }
  await userDoc.ref.set(updates, { merge: true });
  const email = userDoc.data().email;
  if (email && "plan" in updates) {
    await syncOwnerPlanForEmail(db, email, updates.plan);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    res.status(500).send("Webhook not configured");
    return;
  }

  let event;
  try {
    const stripe = getStripe();
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("stripe-webhook signature verification failed", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    const db = getAdminDb();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;

        const uid = session.metadata && session.metadata.firebaseUID;
        const plan = session.metadata && session.metadata.plan;
        if (!uid || !plan) {
          console.warn("checkout.session.completed missing metadata", session.id);
          break;
        }

        const subscription = await getStripe().subscriptions.retrieve(session.subscription);

        await db
          .collection("users")
          .doc(uid)
          .set(
            {
              plan,
              stripeCustomerId: session.customer,
              stripeSubscriptionId: subscription.id,
              planStatus: subscription.status,
              planCancelAtPeriodEnd: !!subscription.cancel_at_period_end,
              currentPeriodEnd: subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
            },
            { merge: true }
          );

        const userSnap = await db.collection("users").doc(uid).get();
        const email = userSnap.exists ? userSnap.data().email : null;
        if (email) await syncOwnerPlanForEmail(db, email, plan);
        break;
      }

      // Fires on renewals, upgrades/downgrades made via the Customer Portal,
      // and whenever cancel_at_period_end is toggled.
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const priceId = subscription.items.data[0] && subscription.items.data[0].price.id;
        const plan = planForPriceId(priceId);

        const updates = {
          planStatus: subscription.status,
          planCancelAtPeriodEnd: !!subscription.cancel_at_period_end,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
        };
        // Only overwrite `plan` if we can positively identify it from the
        // price (e.g. a Pro <-> Business switch made via the portal). If a
        // subscription is simply scheduled to cancel at period end, the plan
        // itself doesn't change yet — that happens on subscription.deleted.
        if (plan) updates.plan = plan;

        await applyPlanForCustomer(db, subscription.customer, updates);
        break;
      }

      // Fires when a subscription actually ends (either the user cancelled
      // immediately in the Stripe Dashboard, or a cancel_at_period_end
      // subscription reached its period end and Stripe auto-cancelled it).
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await applyPlanForCustomer(db, subscription.customer, {
          plan: "free",
          planStatus: "canceled",
          planCancelAtPeriodEnd: false,
          currentPeriodEnd: null,
        });
        break;
      }

      default:
        // Ignore everything else (invoices, payment_intents, etc.).
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("stripe-webhook handler error", err);
    res.status(500).send("Webhook handler error");
  }
};
