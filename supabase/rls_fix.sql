-- START
Before commiting and using this sql i want to ensure is secure and fix the "Advisor" warnsing in Supabase based on existing tables and RLS:
In a hardened way that no user can bypass with codesole codes to cheat the system and gain point in unauthorized methods
(1) Function Search Path Mutable
security

Entity
public.handle_updated_at
Issue
Function public.handle_updated_at has a role mutable search_path

Description
Detects functions where the search_path parameter is not set.

(2) Function Search Path Mutable
security

Entity
public.handle_new_user
Issue
Function public.handle_new_user has a role mutable search_path

Description
Detects functions where the search_path parameter is not set.

(3) Function Search Path Mutable
security

Entity
public.process_multi_game_ledger_points
Issue
Function public.process_multi_game_ledger_points has a role mutable search_path

Description
Detects functions where the search_path parameter is not set.


(4) RLS Policy Always True
security

Entity
public.profiles
Issue
Table public.profiles has an RLS policy Allow profile creation for INSERT that allows unrestricted access (WITH CHECK clause is always true). This effectively bypasses row-level security for -.

Description
Detects RLS policies that use overly permissive expressions like USING (true) or WITH CHECK (true) for UPDATE, DELETE, or INSERT operations. SELECT policies with USING (true) are intentionally excluded as this pattern is often used deliberately for public read access.

(5) Public Can Execute SECURITY DEFINER Function
security

Entity
public.handle_new_user()
Issue
Function public.handle_new_user() can be executed by the anon role as a SECURITY DEFINER function via /rest/v1/rpc/handle_new_user. Revoke EXECUTE or switch it to SECURITY INVOKER if that is not intentional.

Description
Detects SECURITY DEFINER functions that are callable without signing in. Revoke EXECUTE, switch the function to SECURITY INVOKER, or move it out of your exposed API schema if it is not meant to be public.

(6) Signed-In Users Can Execute SECURITY DEFINER Function
security

Entity
public.handle_new_user()
Issue
Function public.handle_new_user() can be executed by the authenticated role as a SECURITY DEFINER function via /rest/v1/rpc/handle_new_user. Revoke EXECUTE or switch it to SECURITY INVOKER if that is not intentional.

Description
Detects SECURITY DEFINER functions that are callable by signed-in users. Revoke EXECUTE, switch the function to SECURITY INVOKER, or move it out of your exposed API schema if signed-in users should not call it.

(7) Leaked Password Protection Disabled
security

Entity
Auth
Issue
Supabase Auth prevents the use of compromised passwords by checking against HaveIBeenPwned.org. Enable this feature to enhance security.

Description
Leaked password protection is currently disabled.



-- END





-- =====================================================
-- GlobalFolkGames — RLS fix for Dynamic-auth users
-- Run this ONCE in the Supabase SQL editor.
--
-- WHY: Players sign in via Dynamic (email OTP). Dynamic users have NO
-- Supabase auth row, so in RLS policies `auth.uid()` is NULL for them.
-- The original policies (`auth.uid() = id`, `auth.uid() = user_id`)
-- therefore block every write:
--   * POST  /point_transactions -> 401 (Unauthorized, RLS reject)
--   * PATCH /profiles           -> 406 (Not Acceptable, .select().single()
--                                     returns no row under RLS)
--
-- The app already trusts the anon (publishable) key and identifies the
-- correct profile via `dynamic_user_id`. We relax the write policies for
-- profiles + point_transactions so Dynamic-backed writes go through.
-- =====================================================

-- -----------------------------------------------------
-- 1. profiles: allow the app to update totals/level
--    (the profile row is keyed by dynamic_user_id; the anon
--     app does the real identity check, not the DB)
-- -----------------------------------------------------
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "App can update profiles"
  ON public.profiles
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------
-- 2. point_transactions: allow the app to read
--    (needed for lifetime local-points totals) + insert
--    audit rows on the user's behalf
-- -----------------------------------------------------
DROP POLICY IF EXISTS "Users can read own transactions" ON public.point_transactions;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.point_transactions;

CREATE POLICY "App can read point transactions"
  ON public.point_transactions
  FOR SELECT
  USING (true);

CREATE POLICY "App can insert point transactions"
  ON public.point_transactions
  FOR INSERT
  WITH CHECK (true);
