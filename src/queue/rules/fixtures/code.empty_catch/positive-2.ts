export async function charge(order: Order) {
  try {
    await stripe.charges.create(order);
  } catch {
  }
  await markPaid(order);
}
