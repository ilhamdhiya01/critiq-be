export const refresh = (token: string) => oauth.refresh(token).catch(() => null);
