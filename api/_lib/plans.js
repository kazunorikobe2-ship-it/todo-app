// Maps our internal plan keys ("pro" / "business") to the Stripe Price IDs
// created in the Stripe Dashboard, via Vercel environment variables. Free has
// no Stripe Price at all (no subscription object exists for free users).
const ADMIN_EMAIL = "kazunorikobe2@gmail.com";

const PAID_PLANS = {
  pro: {
    label: "Pro",
    priceIdEnvVar: "STRIPE_PRICE_PRO",
  },
  business: {
    label: "Business",
    priceIdEnvVar: "STRIPE_PRICE_BUSINESS",
  },
};

function priceIdForPlan(planKey) {
  const def = PAID_PLANS[planKey];
  if (!def) return null;
  return process.env[def.priceIdEnvVar] || null;
}

// Reverse lookup: given a Stripe Price ID (from a subscription item), figure
// out which of our plan keys it corresponds to.
function planForPriceId(priceId) {
  for (const key of Object.keys(PAID_PLANS)) {
    if (priceIdForPlan(key) === priceId) return key;
  }
  return null;
}

module.exports = { ADMIN_EMAIL, PAID_PLANS, priceIdForPlan, planForPriceId };
