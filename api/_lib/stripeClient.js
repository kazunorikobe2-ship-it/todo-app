const Stripe = require("stripe");

let stripeInstance = null;

function getStripe() {
  if (stripeInstance) return stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY environment variable is not set");
  }
  // No pinned apiVersion here on purpose: this Stripe account is on a newer
  // API generation (e.g. Managed Payments/sandbox accounts default to
  // "2025-03-31.basil" or later) and pinning an older version string here
  // caused a hard incompatibility error. Omitting it makes every request use
  // whatever default API version is configured for the account in the
  // Stripe Dashboard, avoiding this class of mismatch entirely.
  stripeInstance = new Stripe(key);
  return stripeInstance;
}

module.exports = { getStripe };
