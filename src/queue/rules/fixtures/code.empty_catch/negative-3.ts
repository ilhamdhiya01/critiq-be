export async function release(key: string) {
  await redis.del(key).catch(() => undefined);
}
