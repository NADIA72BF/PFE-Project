# Zoho Creator Setup for Admin User Management

This note matches [admin_users.html](./admin_users.html) and your Zoho Creator app:

- Account owner: `2demonexflow`
- App link name: `gestion-immobili-re`
- Main report: `All_Users`

## 1. Recommended Creator forms

Use these forms so that every mutation happens through Creator form submission and workflow actions:

1. `All_Users`
Fields:
`ID`, `Full_Name`, `Email`, `Phone`, `Password`, `Confirm_Password`, `Role`

2. `Delete_User_Request`
Fields:
`User_ID`, optional `Requested_By`, optional `Request_Time`

## 2. Workflow 1 - Add User

### Practical note

Because `All_Users` is itself the target form, submitting the form already creates the user record. In this pattern, the "workflow" is the form submission event plus any post-submit action you configure. There is no extra `Add Record` action needed on the same form unless you introduce a separate intake form.

### Exact configuration

- Workflow name: `WF_All_Users_On_Submit`
- Form: `All_Users`
- Trigger event: `Successful form submission`
- Run condition: `Always`
- Criteria: none
- Actions:
  - Optional: `Notification -> Show Success Message`
  - Message text: `User created successfully`

### Required form field validations

Configure these directly on the `All_Users` form fields:

- `Full_Name`: `Mandatory`
- `Email`: `Mandatory`
- `Email`: `No duplicate values`
- `Phone`: `Mandatory`
- `Password`: `Mandatory`
- `Confirm_Password`: `Mandatory`
- `ID`: either `Auto Number` or a normal manual field if you want to type it yourself

### Password confirmation limitation

With the constraint `no Deluge`, Zoho Creator's no-code workflow builder does not give you a reliable blocking rule to enforce `Password == Confirm_Password` on submit. You can:

1. Enforce it in the frontend before calling the form endpoint.
2. Keep both fields mandatory in Creator.
3. If later you allow a tiny Creator validation script, you can block mismatches server-side too.

The included page already blocks mismatches before submission.

## 3. Workflow 2 - Delete User

This one can be fully no-code with a dedicated request form.

### Exact configuration

- Workflow name: `WF_Delete_User_Request`
- Form: `Delete_User_Request`
- Trigger event: `Successful form submission`
- Run condition: `Always`
- Criteria: none
- Actions:
  - Action type: `Data access`
  - Action: `Delete Record`
  - Target form: `All_Users`
  - Delete criteria: `ID == input.User_ID`
  - Optional notification: `Show Success Message`
  - Message text: `User deleted successfully`

### Notes

- If your `All_Users` record identifier is not the Creator system `ID` field, replace the delete criteria with your actual unique field, for example:
  - `User_ID == input.User_ID`
- The `Delete_User_Request` form is the webhook-like endpoint your frontend will call.

## 4. Exact REST API endpoints

These are the official Zoho Creator endpoints for the US data center.

### Fetch all users

`GET https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/report/All_Users`

Headers:

```http
Authorization: Zoho-oauthtoken {access_token}
```

Optional query params:

```text
?from=1&limit=200
```

### Add user by submitting the All_Users form

`POST https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/form/All_Users`

Headers:

```http
Authorization: Zoho-oauthtoken {access_token}
Content-Type: application/json
```

Request body example:

```json
{
  "data": {
    "ID": "10021",
    "Full_Name": "Jane Doe",
    "Email": "jane@example.com",
    "Phone": "+2348012345678",
    "Password": "Secret123!",
    "Confirm_Password": "Secret123!",
    "Role": "Administrator"
  },
  "result": {
    "fields": ["ID", "Full_Name", "Email", "Phone", "Role"],
    "message": true
  }
}
```

If `ID` is auto-generated, omit it from `data`.

### Delete user by submitting the workflow request form

`POST https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/form/Delete_User_Request`

Headers:

```http
Authorization: Zoho-oauthtoken {access_token}
Content-Type: application/json
```

Request body example:

```json
{
  "data": {
    "User_ID": "4899073000001234567"
  },
  "result": {
    "message": true
  }
}
```

That request creates a `Delete_User_Request` record, which triggers `WF_Delete_User_Request`, which deletes the matching record in `All_Users`.

## 5. OAuth setup

### Scopes you need

- `ZohoCreator.report.READ`
- `ZohoCreator.form.CREATE`

If you later delete directly through report endpoints instead of the request form workflow, you would also need:

- `ZohoCreator.report.DELETE`

### Generate your OAuth app

1. Open Zoho API Console.
2. Create a server-based or self-client application.
3. Generate the grant code.
4. Exchange it for:
   - `access_token`
   - `refresh_token`
5. Use the correct regional accounts domain for your tenant.

US examples:

- Accounts base URL: `https://accounts.zoho.com`
- API base URL: `https://www.zohoapis.com`

### Refresh token request

`POST https://accounts.zoho.com/oauth/v2/token?refresh_token={refresh_token}&client_id={client_id}&client_secret={client_secret}&grant_type=refresh_token`

Response example:

```json
{
  "access_token": "1000.xxxxx",
  "api_domain": "https://www.zohoapis.com",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

## 6. Security note for your chosen architecture

You asked for no custom backend server. That is workable for reading data and for local admin usage, but there is an important security tradeoff:

- A browser-only app cannot securely store `client_secret` and `refresh_token`.
- If you embed them in frontend code, any admin user can extract them.

So the safe options are:

1. Local/manual admin testing:
   Use a short-lived access token pasted into the page session.

2. Production-safe:
   Move token refresh to a secure server-side component, edge function, or Zoho-managed trusted runtime.

The included page supports a session token paste flow and can also use injected runtime config if you later place it behind a secure delivery mechanism.

## 7. Sources

- Zoho Creator Add Records API: https://www.zoho.com/creator/help/api/v2/add-records.html
- Zoho Creator Get Records API: https://www.zoho.com/creator/help/api/v2/get-records.html
- Zoho Creator configure add record action: https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-on-success-action/articles/configure-add-record-action
- Zoho Creator configure delete record action: https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-on-success-action/articles/configure-delete-record-action
- Zoho Creator form workflows overview: https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-form-workflows/articles/understand-formworkflows
- Zoho OAuth refresh token endpoint: https://www.zoho.com/creator/help/api/v2/refresh-the-access-token.html
