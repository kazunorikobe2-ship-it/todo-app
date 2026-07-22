// Mirrors app.js's client-side savePlanForCurrentUser(): whenever a user's
// plan changes, the denormalized `ownerPlan` field on every project they own
// must be updated too, since that's what actually gates features for anyone
// viewing that project (see effectivePlanForProject in app.js).
async function syncOwnerPlanForEmail(db, email, plan) {
  if (!email) return;
  const snap = await db.collection("projects").where("ownerEmail", "==", email).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.forEach((doc) => {
    batch.update(doc.ref, { ownerPlan: plan });
  });
  await batch.commit();
}

module.exports = { syncOwnerPlanForEmail };
