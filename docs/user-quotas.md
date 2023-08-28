# User Quotas

When using `user_token` authentication, you can set (model) token quotas for user.  These quotas are enforced by the proxy server and are separate from the quotas enforced by OpenAI.

You can set the default quota via environment variables. Quotas are enforced on a per-model basis, and count both prompt tokens and completion tokens. By default, all quotas are disabled.

Set the following environment variables to set the default quotas:
- `TOKEN_QUOTA_TURBO`
- `TOKEN_QUOTA_GPT4`
- `TOKEN_QUOTA_CLAUDE`

Quotas only apply to `normal`-type users; `special`-type users are exempt from quotas. You can change users' types via the REST API.

**Note that changes to these environment variables will only apply to newly created users.**  To modify existing users' quotas, use the REST API or the admin UI.

## Automatically refreshing quotas

You can use the `QUOTA_REFRESH_PERIOD` environment variable to automatically refresh users' quotas periodically.  This is useful if you want to give users a certain number of tokens per day, for example. The entire quota will be refreshed at the start of the specified period, and any tokens a user has not used will not be carried over.

Quotas for all models and users will be refreshed. If you haven't set `TOKEN_QUOTA_*` for a particular model, quotas for that model will not be refreshed (so any manually set quotas will not be overwritten).

Set the `QUOTA_REFRESH_PERIOD` environment variable to one of the following values:
- `daily` (at midnight)
- `hourly`
- leave unset to disable automatic refreshing

You can also use a cron expression, for example:
- Every 45 seconds: `"*/45 * * * * *"`
- Every 30 minutes: `"*/30 * * * *"`
- Every 6 hours: `"0 */6 * * *"`
- Every 3 days: `"0 0 */3 * *"`
- Daily, but at mid-day: `"0 12 * * *"`

Make sure to enclose the cron expression in quotation marks.

All times are in the server's local time zone. Refer to [crontab.guru](https://crontab.guru/) for more examples.
