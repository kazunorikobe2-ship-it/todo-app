const Stripe = require("stripe");

let stripeInstance = null;

function getStripe() {
  if (stripeInstance) return stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY environment variable is not set");
  }
  // The installed `stripe` npm package itself bakes in a default API version
  // (matching its own release date) and sends that unless we override it —
  // simply omitting this option does NOT mean "no version pinned", it means
  // "use the SDK's built-in default", which turned out to be the old
  // "2024-06-20" version incompatible with this account's Managed Payments
  // feature. Pin explicitly to the version Stripe's own error message named.
  stripeInstance = new Stripe(key, { apiVersion: "2025-03-31.basil" });
  return stripeInstance;
}

module.exports = { getStripe };
