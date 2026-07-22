const Stripe = require("stripe");

let stripeInstance = null;

function getStripe() {
  if (stripeInstance) return stripeInstance;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY environment variable is not set");
  }
  stripeInstance = new Stripe(key, { apiVersion: "2024-06-20" });
  return stripeInstance;
}

module.exports = { getStripe };
