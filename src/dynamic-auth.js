// src/dynamic-auth.js
// Primary login via Dynamic (email → self-custody Solana wallet)
// Supabase is used only as backup profile store

import { createDynamicClient } from '@dynamic-labs-sdk/client';
import { addSolanaExtension } from '@dynamic-labs-sdk/solana';

const ENVIRONMENT_ID = '0fd49c9c-1b54-4dc5-88a0-924dd3607bf3'; // ← replace with your real ID

// Create the Dynamic client
const dynamicClient = createDynamicClient({
  environmentId: ENVIRONMENT_ID,
  metadata: {
    name: 'GlobalFolkGames',
    universalLink: window.location.origin,
  },
});

// Add Solana support
addSolanaExtension();

// Make it available globally for the rest of the project
window.dynamicClient = dynamicClient;

console.log('Dynamic client initialized');