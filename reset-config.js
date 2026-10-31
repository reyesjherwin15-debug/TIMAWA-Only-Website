/* ============================================================================
   TIMAWA — password reset configuration

   Deploy reset-worker.js on Cloudflare Workers (see PASSWORD-RESET-SETUP.md),
   then paste the Worker URL below. Nothing secret belongs in this file: the
   reset code is checked inside the Worker, and the service account never leaves
   Cloudflare.
   ========================================================================== */

window.TIMAWA_RESET = {
    endpoint: 'https://timawa-reset.reyesjherwin15.workers.dev'
};
