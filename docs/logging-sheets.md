# Warning
**I strongly suggest against using this feature with a Google account that you care about.** Depending on the content of the prompts people submit, Google may flag the spreadsheet as containing inappropriate content. This seems to prevent you from sharing that spreadsheet _or any others on the account. This happened with my throwaway account during testing; the existing shared spreadsheet continues to work but even completely new spreadsheets are flagged and cannot be shared.

I'll be looking into alternative storage backends but you should not use this implementation with a Google account you care about, or even one remotely connected to your main accounts (as Google has a history of linking accounts together via IPs/browser fingerprinting). Use a VPN and completely isolated VM to be safe.

# Configuring Google Sheets Prompt Logging
This proxy can log incoming prompts and model responses to Google Sheets. Some configuration on the Google side is required to enable this feature. The APIs used are free, but you will need a Google account and a Google Cloud Platform project.

NOTE: Concurrency is not supported. Don't connect two instances of the server to the same spreadsheet or bad things will happen.

## Prerequisites
- A Google account
  - **USE A THROWAWAY ACCOUNT!**
- A Google Cloud Platform project

### 0. Create a Google Cloud Platform Project
_A Google Cloud Platform project is required to enable programmatic access to Google Sheets. If you already have a project, skip to the next step. You can also see the [Google Cloud Platform documentation](https://developers.google.com/workspace/guides/create-project) for more information._

- Go to the Google Cloud Platform Console and [create a new project](https://console.cloud.google.com/projectcreate).

### 1. Enable the Google Sheets API
_The Google Sheets API must be enabled for your project. You can also see the [Google Sheets API documentation](https://developers.google.com/sheets/api/quickstart/nodejs) for more information._

- Go to the [Google Sheets API page](https://console.cloud.google.com/apis/library/sheets.googleapis.com) and click **Enable**, then fill in the form to enable the Google Sheets API for your project.
<!-- TODO: Add screenshot of Enable page and describe filling out the form -->

### 2. Create a Service Account
_A service account is required to authenticate the proxy to Google Sheets._

- Once the Google Sheets API is enabled, click the **Credentials** tab on the Google Sheets API page.
- Click **Create credentials** and select **Service account**.
- Provide a name for the service account and click **Done** (the second and third steps can be skipped).

### 3. Download the Service Account Key
_Once your account is created, you'll need to download the key file and include it in the proxy's secrets configuration._

- Click the Service Account you just created in the list of service accounts for the API.
- Click the **Keys** tab and click **Add key**, then select **Create new key**.
- Select **JSON** as the key type and click **Create**.

The JSON file will be downloaded to your computer.

### 4. Set the Service Account key as a Secret
_The JSON key file must be set as a secret in the proxy's configuration. Because files cannot be included in the secrets configuration, you'll need to base64 encode the file's contents and paste the encoded string as the value of the `GOOGLE_SHEETS_KEY` secret._

- Open the JSON key file in a text editor and copy the contents.
- Visit the [base64 encode/decode tool](https://www.base64encode.org/) and paste the contents into the box, then click **Encode**.
- Copy the encoded string and paste it as the value of the `GOOGLE_SHEETS_KEY` secret in the deployment's secrets configuration.
  - **WARNING:** Don't reveal this string publically. The `.env` file is NOT private -- unless you're running the proxy locally, you should not use it to store secrets!

### 5. Create a new spreadsheet and share it with the service account
_The service account must be given permission to access the logging spreadsheet. Each service account has a unique email address, which can be found in the JSON key file; share the spreadsheet with that email address just as you would share it with another user._

- Open the JSON key file in a text editor and copy the value of the `client_email` field.
- Open the spreadsheet you want to log to, or create a new one, and click **File > Share**.
- Paste the service account's email address into the **Add people or groups** field. Ensure the service account has **Editor** permissions, then click **Done**.

### 6. Set the spreadsheet ID as a Secret
_The spreadsheet ID must be set as a secret in the proxy's configuration. The spreadsheet ID can be found in the URL of the spreadsheet. For example, the spreadsheet ID for `https://docs.google.com/spreadsheets/d/1X2Y3Z/edit#gid=0` is `1X2Y3Z`.  The ID isn't necessarily a sensitive value if you intend for the spreadsheet to be public, but it's still recommended to set it as a secret._

- Copy the spreadsheet ID and paste it as the value of the `GOOGLE_SHEETS_SPREADSHEET_ID` secret in the deployment's secrets configuration.
