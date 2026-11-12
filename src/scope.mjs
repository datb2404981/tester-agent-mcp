// Match the registered origin and a whole path segment for document navigation.
export const isPageInScope = (target, base) => {
  const root = base.pathname.replace(/\/+$/, '');
  return isHttpTarget(target) && target.origin === base.origin &&
    (target.pathname === root || target.pathname.startsWith(root + '/')) &&
    !/%(?:25|2f|5c|2e)/i.test(target.pathname);
};

export const isHttpTarget = (url) =>
  ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
