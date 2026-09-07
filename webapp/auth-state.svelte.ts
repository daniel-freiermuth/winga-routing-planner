// Shared reactive auth state — imported by any component needing login status.

export const authState = $state({ status: 'unknown', username: '' });
