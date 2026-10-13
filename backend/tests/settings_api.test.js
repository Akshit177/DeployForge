const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const authRoutes = require("../routes/auth.js");
const settingsRoutes = require("../routes/settings.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/settings", settingsRoutes);
  return app;
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Settings & Account Security API Tests");
  console.log("==================================================");

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ ${message}`);
      failed++;
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // 1. Unauthenticated checks
    const unauthGet = await fetch(`${baseUrl}/api/settings`);
    assert(unauthGet.status === 401, "GET /api/settings without token returns 401 Unauthorized");

    const unauthPutProfile = await fetch(`${baseUrl}/api/settings/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacker" }),
    });
    assert(unauthPutProfile.status === 401, "PUT /api/settings/profile without token returns 401");

    const unauthPutPass = await fetch(`${baseUrl}/api/settings/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: "abc", new_password: "xyz" }),
    });
    assert(unauthPutPass.status === 401, "PUT /api/settings/password without token returns 401");

    // 2. Register User A
    const userAEmail = `settings_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Original Name",
        email: userAEmail,
        password: "OriginalPassword123!",
      }),
    });
    assert(regResA.status === 201, "User A registered successfully");
    const cookieA = regResA.headers.get("set-cookie").split(";")[0];

    // 3. GET /api/settings for User A
    const getSettingsA = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: cookieA },
    });
    assert(getSettingsA.status === 200, "GET /api/settings returned 200 OK");
    const settingsDataA = await getSettingsA.json();
    assert(settingsDataA.user.user_name === "Original Name", "Profile returns user_name");
    assert(settingsDataA.user.email === userAEmail, "Profile returns correct email");
    assert(settingsDataA.user.github_connected === false, "Default github_connected is false");
    assert(Array.isArray(settingsDataA.domains), "Settings returns domains array");

    // 4. PUT /api/settings/profile validation
    const badNameRes = await fetch(`${baseUrl}/api/settings/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ name: " " }),
    });
    assert(badNameRes.status === 400, "Profile update with invalid name returns 400");

    const badEmailRes = await fetch(`${baseUrl}/api/settings/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert(badEmailRes.status === 400, "Profile update with invalid email returns 400");

    // 5. Valid PUT /api/settings/profile
    const updateProfileRes = await fetch(`${baseUrl}/api/settings/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: "Lead Architect",
        github_connected: true,
      }),
    });
    assert(updateProfileRes.status === 200, "Profile updated successfully (200)");
    const updatedUser = (await updateProfileRes.json()).user;
    assert(updatedUser.user_name === "Lead Architect", "Updated name reflects in response");
    assert(updatedUser.github_connected === true, "Updated github_connected is true");

    // 6. Register User B to test uniqueness and multi-tenant isolation
    const userBEmail = `settings_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "User B",
        email: userBEmail,
        password: "UserBPassword123!",
      }),
    });
    assert(regResB.status === 201, "User B registered successfully");
    const cookieB = regResB.headers.get("set-cookie").split(";")[0];

    // 7. User B tries to change email to User A's email -> 409
    const conflictEmailRes = await fetch(`${baseUrl}/api/settings/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ email: userAEmail }),
    });
    assert(conflictEmailRes.status === 409, "Duplicate email update returns 409 Conflict");

    // 8. Password changes
    const wrongCurrentPassRes = await fetch(`${baseUrl}/api/settings/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        current_password: "WrongPassword999!",
        new_password: "BrandNewPassword123!",
      }),
    });
    assert(wrongCurrentPassRes.status === 400, "Wrong current password returns 400");

    const shortPassRes = await fetch(`${baseUrl}/api/settings/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        current_password: "OriginalPassword123!",
        new_password: "short",
      }),
    });
    assert(shortPassRes.status === 400, "Short new password returns 400");

    const validPassRes = await fetch(`${baseUrl}/api/settings/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        current_password: "OriginalPassword123!",
        new_password: "BrandNewPassword123!",
      }),
    });
    assert(validPassRes.status === 200, "Valid password update returns 200 OK");

    // Verify login with old vs new password
    const oldLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: userAEmail, password: "OriginalPassword123!" }),
    });
    assert(oldLoginRes.status === 401, "Old password is now rejected with 401");

    const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: userAEmail, password: "BrandNewPassword123!" }),
    });
    assert(newLoginRes.status === 200, "New password signs in successfully (200)");

    // 9. Alert preferences update
    const updateNotifyRes = await fetch(`${baseUrl}/api/settings/notifications`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        notify_failures: false,
        notify_weekly: true,
      }),
    });
    assert(updateNotifyRes.status === 200, "PUT /api/settings/notifications returns 200");
    const notifyBody = await updateNotifyRes.json();
    assert(notifyBody.notification_preferences.notify_failures === false, "notify_failures updated to false");
    assert(notifyBody.notification_preferences.notify_weekly === true, "notify_weekly updated to true");

    // 10. Custom Domains
    const testDomain = `app-${Date.now()}.customcorp.com`;
    const invalidDomainRes = await fetch(`${baseUrl}/api/settings/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ domain: "invalid-domain-without-tld" }),
    });
    assert(invalidDomainRes.status === 400, "Invalid domain format rejected with 400");

    const addDomainRes = await fetch(`${baseUrl}/api/settings/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ domain: testDomain }),
    });
    assert(addDomainRes.status === 201, "POST /api/settings/domains returns 201 Created");
    const createdDomain = (await addDomainRes.json()).domain;
    assert(createdDomain.domain === testDomain, "Created domain name matches");
    assert(createdDomain.status === "Active", "Created domain default status is Active");

    // Duplicate domain check across platform
    const dupDomainRes = await fetch(`${baseUrl}/api/settings/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ domain: testDomain }),
    });
    assert(dupDomainRes.status === 409, "User B attempting to claim existing domain returns 409 Conflict");

    // User B attempting to delete User A's domain
    const crossDeleteRes = await fetch(`${baseUrl}/api/settings/domains/${createdDomain.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieB },
    });
    assert(crossDeleteRes.status === 404, "User B cannot delete User A's domain (404 Not Found)");

    // User A successfully deletes their domain
    const deleteDomainRes = await fetch(`${baseUrl}/api/settings/domains/${createdDomain.id}`, {
      method: "DELETE",
      headers: { Cookie: cookieA },
    });
    assert(deleteDomainRes.status === 200, "User A deletes domain successfully (200)");

    // Confirm domain is gone
    const listDomainsRes = await fetch(`${baseUrl}/api/settings/domains`, {
      headers: { Cookie: cookieA },
    });
    const remainingDomains = (await listDomainsRes.json()).domains;
    assert(
      !remainingDomains.some((d) => d.id === createdDomain.id),
      "Deleted domain no longer present in user's domain list"
    );

    console.log("==================================================");
    console.log(`  All Settings API tests passed! (${passed}/${passed})`);
    console.log("==================================================");
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  } finally {
    server.close();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
  });
