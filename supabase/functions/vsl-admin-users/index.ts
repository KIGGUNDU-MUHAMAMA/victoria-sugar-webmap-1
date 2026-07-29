/**
 * vsl-admin-users — Admin-only account management (Supabase Edge Function).
 *
 * Only signed-in users whose vsl_profiles.role = 'ADMIN' may call this. Every request
 * must include the caller's normal Supabase session JWT in the Authorization header
 * (this is automatic when calling supabase.functions.invoke() from a logged-in client).
 *
 * Actions (POST body: { action, ...payload }):
 *  - "list"       -> returns all vsl_profiles rows (admin directory view)
 *  - "create"     -> creates a real Supabase Auth user + vsl_profiles row with a chosen role
 *  - "update"     -> updates role/full_name/phone/title/estate_id/is_active on an existing user
 *  - "deactivate" -> bans sign-in (auth) and sets is_active=false, without deleting the account
 *  - "reactivate" -> lifts the ban and sets is_active=true
 *  - "delete"     -> permanently deletes the Auth user (cascades to vsl_profiles)
 *  - "reset_password" -> sends a password reset email to the user
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VALID_ROLES = ["ADMIN", "SURVEYOR", "MANAGMENT"];

function ok(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function fail(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "Use POST");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return fail(401, "Missing Authorization bearer token.");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the caller from their JWT, then confirm they are an ADMIN.
  const { data: callerRes, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !callerRes?.user) return fail(401, "Invalid or expired session.");
  const callerId = callerRes.user.id;

  const { data: callerProfile, error: profErr } = await admin
    .from("vsl_profiles")
    .select("role")
    .eq("id", callerId)
    .single();
  if (profErr || !callerProfile) return fail(403, "No profile found for caller.");
  if (callerProfile.role !== "ADMIN") return fail(403, "Only ADMIN users can manage accounts.");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid JSON body.");
  }
  const action = String(body.action || "");

  try {
    if (action === "list") {
      const { data, error } = await admin
        .from("vsl_profiles")
        .select("id, email, role, full_name, phone, title, estate_id, is_active, last_login_at, created_at, updated_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ok({ users: data });
    }

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = String(body.role || "");
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return fail(400, "Valid email is required.");
      if (!password || password.length < 8) return fail(400, "Password must be at least 8 characters.");
      if (!VALID_ROLES.includes(role)) return fail(400, `Role must be one of: ${VALID_ROLES.join(", ")}`);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role },
      });
      if (createErr) throw createErr;
      const newId = created.user!.id;

      // vsl_handle_new_auth_user trigger already inserted a bare vsl_profiles row; fill in the rest.
      const { error: updErr } = await admin
        .from("vsl_profiles")
        .update({
          role,
          full_name: body.full_name ? String(body.full_name) : null,
          phone: body.phone ? String(body.phone) : null,
          title: body.title ? String(body.title) : null,
          estate_id: body.estate_id ?? null,
        })
        .eq("id", newId);
      if (updErr) throw updErr;

      return ok({ id: newId });
    }

    if (action === "update") {
      const id = String(body.id || "");
      if (!id) return fail(400, "id is required.");
      const patch: Record<string, unknown> = {};
      if (body.role !== undefined) {
        if (!VALID_ROLES.includes(String(body.role))) return fail(400, `Role must be one of: ${VALID_ROLES.join(", ")}`);
        patch.role = body.role;
      }
      if (body.full_name !== undefined) patch.full_name = body.full_name || null;
      if (body.phone !== undefined) patch.phone = body.phone || null;
      if (body.title !== undefined) patch.title = body.title || null;
      if (body.estate_id !== undefined) patch.estate_id = body.estate_id || null;
      if (body.is_active !== undefined) patch.is_active = !!body.is_active;

      const { error } = await admin.from("vsl_profiles").update(patch).eq("id", id);
      if (error) throw error;

      if (body.role !== undefined) {
        await admin.auth.admin.updateUserById(id, { user_metadata: { role: body.role } });
      }
      return ok({});
    }

    if (action === "deactivate" || action === "reactivate") {
      const id = String(body.id || "");
      if (!id) return fail(400, "id is required.");
      const banning = action === "deactivate";
      const { error: banErr } = await admin.auth.admin.updateUserById(id, {
        ban_duration: banning ? "876000h" : "none",
      });
      if (banErr) throw banErr;
      const { error: profErr2 } = await admin
        .from("vsl_profiles")
        .update({ is_active: !banning })
        .eq("id", id);
      if (profErr2) throw profErr2;
      return ok({});
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return fail(400, "id is required.");
      if (id === callerId) return fail(400, "You cannot delete your own account.");
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return ok({});
    }

    if (action === "reset_password") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return fail(400, "email is required.");
      const { error } = await admin.auth.resetPasswordForEmail(email);
      if (error) throw error;
      return ok({});
    }

    return fail(400, `Unknown action: ${action}`);
  } catch (err) {
    console.error("vsl-admin-users error:", err);
    return fail(500, err instanceof Error ? err.message : "Unexpected error.");
  }
});
