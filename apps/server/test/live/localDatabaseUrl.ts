const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const isLocalDatabaseUrl = (url: string): boolean =>
  LOCAL_HOSTS.includes(new URL(url).hostname);
