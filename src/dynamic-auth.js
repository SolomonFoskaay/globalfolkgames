// src/dynamic-auth.js
// Primary login via Dynamic (email OTP → self-custody Solana wallet)
// Supabase is backup only

import { createDynamicClient, sendEmailOTP, verifyOTP, logout } from '@dynamic-labs-sdk/client';
import { addSolanaExtension } from '@dynamic-labs-sdk/solana';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';

const ENVIRONMENT_ID = '0fd49c9c-1b54-4dc5-88a0-924dd3607bf3'; // ← your real ID

const dynamicClient = createDynamicClient({
  environmentId: ENVIRONMENT_ID,
  metadata: {
    name: 'GlobalFolkGames',
    universalLink: window.location.origin,
  },
});

addSolanaExtension();
window.dynamicClient = dynamicClient;

console.log('Dynamic client initialized');

let currentOtpVerification = null;

window.openDynamicLogin = function () {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;
  showEmailStep();
  modal.classList.add('visible');
};

function showEmailStep() {
  const content = document.querySelector('.auth-modal-content');
  if (!content) return;

  content.innerHTML = `
    <button id="auth-modal-close" class="auth-modal-close">×</button>
    <h2>Sign in</h2>
    <p class="auth-hint">Enter your email. We will send you a one-time code.</p>
    <input type="email" id="auth-email" placeholder="Email address" autocomplete="email">
    <div class="auth-actions">
      <button id="btn-send-otp" class="auth-btn primary">Send Code</button>
    </div>
  `;

  document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-send-otp')?.addEventListener('click', handleSendOTP);
}

function showOtpStep(email) {
  const content = document.querySelector('.auth-modal-content');
  if (!content) return;

  content.innerHTML = `
    <button id="auth-modal-close" class="auth-modal-close">×</button>
    <h2>Enter Code</h2>
    <p class="auth-hint">We sent a code to <strong>${email}</strong></p>
    <input type="text" id="auth-otp" placeholder="6-digit code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
    <div class="auth-actions">
      <button id="btn-verify-otp" class="auth-btn primary">Verify & Sign In</button>
      <button id="btn-back-email" class="auth-btn secondary">Back</button>
    </div>
  `;

  document.getElementById('auth-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('btn-verify-otp')?.addEventListener('click', handleVerifyOTP);
  document.getElementById('btn-back-email')?.addEventListener('click', showEmailStep);
}

function closeModal() {
  document.getElementById('auth-modal')?.classList.remove('visible');
  currentOtpVerification = null;
}

async function handleSendOTP() {
  const emailInput = document.getElementById('auth-email');
  const email = emailInput?.value.trim();
  const btn = document.getElementById('btn-send-otp');

  if (!email) {
    if (window.showAuthBanner) window.showAuthBanner('Please enter your email', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    currentOtpVerification = await sendEmailOTP({ email });
    showOtpStep(email);
  } catch (err) {
    console.error('Send OTP error:', err);
    if (window.showAuthBanner) window.showAuthBanner(err.message || 'Failed to send code', true);
    btn.disabled = false;
    btn.textContent = 'Send Code';
  }
}

async function handleVerifyOTP() {
  const otpInput = document.getElementById('auth-otp');
  const code = otpInput?.value.trim();
  const btn = document.getElementById('btn-verify-otp');

  if (!code || code.length < 4) {
    if (window.showAuthBanner) window.showAuthBanner('Please enter the code', true);
    return;
  }

  if (!currentOtpVerification) {
    if (window.showAuthBanner) window.showAuthBanner('Please request a new code', true);
    showEmailStep();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying…';

  try {
  await verifyOTP({
    otpVerification: currentOtpVerification,
    verificationToken: code,
  });

  // === IMPORTANT: Create the embedded Solana wallet ===
  try {
    const missingChains = getChainsMissingWaasWalletAccounts();
    if (missingChains && missingChains.length > 0) {
      await createWaasWalletAccounts({ chains: missingChains });
      console.log('Embedded Solana wallet created');
    } else {
      // Force creation for Solana if the helper returns empty
      await createWaasWalletAccounts({ chains: ['solana'] });
      console.log('Embedded Solana wallet created (forced)');
    }
  } catch (walletErr) {
    console.error('Wallet creation error:', walletErr);
  }

  closeModal();
  if (window.showAuthBanner) window.showAuthBanner('Signed in successfully!');

  // Refresh header after a short delay so the wallet is available
  setTimeout(() => {
    if (window.refreshAuthHeader) window.refreshAuthHeader();
  }, 800);

  } catch (err) {
    console.error('Verify OTP error:', err);
    if (window.showAuthBanner) window.showAuthBanner(err.message || 'Invalid code', true);
    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
  }
}

// Proper logout
window.logoutDynamic = async function () {
  try {
    await logout();
    console.log('Dynamic logout successful');
  } catch (err) {
    console.error('Dynamic logout error:', err);
  }

  window.currentUser = null;
  window.currentProfile = null;

  if (window.refreshAuthHeader) {
    window.refreshAuthHeader();
  }
};