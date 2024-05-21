# Proof-of-work Verification

You can require users to complete a proof-of-work before they can access the
proxy. This can increase the cost of denial of service attacks and slow down
automated abuse.

When configured, users access the challenge UI and request a token. The server
sends a challenge to the client, which asks the user's browser to find a 
solution to the challenge that meets a certain constraint (the difficulty
level). Once the user has found a solution, they can submit it to the server
and get a user token valid for a period you specify.

The proof-of-work challenge uses the argon2id hash function.

## Configuration

To enable proof-of-work verification, set the following environment variables:

```
GATEKEEPER=user_token
CAPTCHA_MODE=proof_of_work
# Validity of the token in hours
POW_TOKEN_HOURS=24
# Max number of IPs that can use a user_token issued via proof-of-work
POW_TOKEN_MAX_IPS=2
# The difficulty level of the proof-of-work challenge. You can use one of the
# predefined levels specified below, or you can specify a custom number of
# expected hash iterations.
POW_DIFFICULTY_LEVEL=low
```

## Difficulty Levels

The difficulty level controls how long, on average, it will take for a user to
solve the proof-of-work challenge. Due to randomness, the actual time can very
significantly; lucky users may solve the challenge in a fraction of the average
time, while unlucky users may take much longer.

The difficulty level doesn't affect the speed of the hash function itself, only
the number of hashes that will need to be computed. Therefore, the time required
to complete the challenge scales linearly with the difficulty level's iteration
count.

You can adjust the difficulty level while the proxy is running from the admin
interface.

Be aware that there is a time limit for solving the challenge, by default set to
30 minutes. Above 'high' difficulty, you will probably need to increase the time
limit or it will be very hard for users with slow devices to find a solution
within the time limit.

### Low

- Average of 200 iterations required
- Default setting.

### Medium

- Average of 900 iterations required

### High

- Average of 1900 iterations required

### Extreme

- Average of 4000 iterations required
- Not recommended unless you are expecting very high levels of abuse
- May require increasing `POW_CHALLENGE_TIMEOUT`

### Custom

Setting `POW_DIFFICULTY_LEVEL` to an integer will use that number of iterations
as the difficulty level.

## Other challenge settings

- `POW_CHALLENGE_TIMEOUT`: The time limit for solving the challenge, in minutes.
  Default is 30.
- `POW_TOKEN_HOURS`: The period of time for which a user token issued via proof-
  of-work can be used. Default is 24 hours. Starts when the challenge is solved.
- `POW_TOKEN_MAX_IPS`: The maximum number of unique IPs that can use a single
  user token issued via proof-of-work. Default is 2.
- `POW_TOKEN_PURGE_HOURS`: The period of time after which an expired user token
  issued via proof-of-work will be removed from the database. Until it is
  purged, users can refresh expired tokens by completing a half-difficulty
  challenge. Default is 48 hours.
- `POW_MAX_TOKENS_PER_IP`: The maximum number of active user tokens that can
  be associated with a single IP address. After this limit is reached, the
  oldest token will be forcibly expired when a new token is issued. Set to 0
  to disable this feature. Default is 0.

## Custom argon2id parameters

You can set custom argon2id parameters for the proof-of-work challenge.
Generally, you should not need to change these unless you have a specific
reason to do so.

The listed values are the defaults.

```
ARGON2_TIME_COST=8
ARGON2_MEMORY_KB=65536
ARGON2_PARALLELISM=1
ARGON2_HASH_LENGTH=32
```

Increasing parallelism will not do much except increase memory consumption for
both the client and server, because browser proof-of-work implementations are
single-threaded. It's better to increase the time cost if you want to increase
the difficulty.

Increasing memory too much may cause memory exhaustion on some mobile devices,
particularly on iOS due to the way Safari handles WebAssembly memory allocation.

## Tested hash rates

These were measured with the default argon2id parameters listed above. These
tests were not at all scientific so take them with a grain of salt.

Safari does not like large WASM memory usage, so concurrency is limited to 4 to
avoid overallocating memory on mobile WebKit browsers. Thermal throttling can
also significantly reduce hash rates on mobile devices.

- Intel Core i9-13900K (Chrome): 33-35 H/s
- Intel Core i9-13900K (Firefox): 29-32 H/s
- Intel Core i9-13900K (Chrome, in VM limited to 4 cores): 12.2 - 13.0 H/s
- iPad Pro (M2) (Safari, 6 workers): 8.0 - 10 H/s
  - Thermal throttles early. 8 cores is normal concurrency, but unstable.
- iPhone 13 Pro (Safari): 4.0 - 4.6 H/s
- Samsung Galaxy S10e (Chrome): 3.6 - 3.8 H/s
  - This is a 2019 phone almost matching an iPhone five years newer because of
    bad Safari performance.
