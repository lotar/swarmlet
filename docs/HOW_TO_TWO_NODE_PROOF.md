# How to run the two-node expert proof

This guide runs the same plan-pinned tiny-MoE owners on two Ubuntu machines, carries every RPC through authenticated SSH local forwards, crashes one owner, and preserves signed evidence after cleanup.

## Prerequisites

On the coordinator:

- this repository at the commit to test;
- Bun 1.3.14, Python 3.12+, OpenSSL;
- key-only SSH access to both Ubuntu hosts;
- the SSH host keys already verified in `~/.ssh/known_hosts`.

On each owner:

- the same repository commit at `~/ai-mesh` or another identical path;
- Bun 1.3.14 and Python 3;
- enough permission to run user processes; `sudo` is not required by the proof.

The proof refuses password prompts, unknown host keys, mismatched commits, wrong Bun versions, occupied tunnels, changed fixtures, stale epochs, and unsafe public owner URLs.

## 1. Verify both checkouts

```bash
git rev-parse HEAD
ssh legion-a 'git -C ~/ai-mesh rev-parse HEAD; bun --version'
ssh legion-b 'git -C ~/ai-mesh rev-parse HEAD; bun --version'
```

All commits must match and each Bun version must print `1.3.14`.

## 2. Pin the SSH host keys

Connect interactively once and compare each fingerprint with the laptop screen or router inventory:

```bash
ssh legion-a exit
ssh legion-b exit
```

Never use `StrictHostKeyChecking=no`. The proof uses the existing pinned host keys.

## 3. Run the complete proof

From `sin-harness/` on the coordinator:

```bash
NODE_A=lotar@192.168.1.243 \
NODE_B=lotar@192.168.1.244 \
REMOTE_REPO='~/ai-mesh' \
bun run test:hardware
```

The runner:

1. verifies the same Git commit and Bun version;
2. creates a one-run admin token and sends it only through SSH;
3. starts one exact supervisor/owner on each host;
4. forwards local ports 19571 and 19572 without wildcard binding;
5. verifies plan, node identity, expert IDs, fixture digests, and epoch;
6. executes 64-token exact parity and network benchmarks;
7. rejects a foreign expert and stale epoch;
8. crashes owner `n2` during a routed request and requires fail-closed behavior;
9. waits for a plan-identical supervised restart and rechecks parity;
10. stops exact owned PIDs/tunnels, removes tokens, and signs the result.

## 4. Pin the evidence signer

The first successful run creates a local Ed25519 key under the ignored directory `sin-harness/data/keys/two-node/`. Copy the printed signer fingerprint to a separate trusted record.

For every later run, require that fingerprint:

```bash
TRUSTED_FINGERPRINT='<64-hex-fingerprint>' \
NODE_A=lotar@192.168.1.243 \
NODE_B=lotar@192.168.1.244 \
bun run test:hardware
```

A replaced key then fails the run.

## 5. Inspect the report

The command prints its output directory. It contains:

```text
hosts.json          captured host/kernel/RAM/GPU lines
node-a.txt          raw node A inventory
node-b.txt          raw node B inventory
result.json         unsigned proof result after cleanup
result.signed.json  authoritative Ed25519-signed run manifest
```

Verify the signature using the pinned fingerprint and `run_manifest.verify()`; do not trust only the public key embedded beside a new signature.

## Verification

A passing result contains:

```json
{
  "outcome": "pass",
  "assertions": {
    "ownershipExact": true,
    "foreignExpertRejected": true,
    "staleEpochRejected": true,
    "referenceParity": true,
    "failedClosed": true,
    "restartObserved": true,
    "restartParity": true
  },
  "cleanup": {
    "ownedTunnelExited": true,
    "ownedRemoteSupervisorsStopped": true,
    "adminTokenRemoved": true
  }
}
```

Also verify manually:

```bash
ss -lntp | grep -E ':9571|:9572' && exit 1 || true
ssh legion-a "test ! -e ~/ai-mesh/sin-harness/data/two-node/n1.pid"
ssh legion-b "test ! -e ~/ai-mesh/sin-harness/data/two-node/n2.pid"
```

## Troubleshooting

### SSH port 22 is closed

Enable SSH locally on that Ubuntu machine:

```bash
sudo apt install openssh-server
sudo systemctl enable --now ssh
```

A password cannot create remote access until `sshd` is listening.

### Commit mismatch

Do not copy arbitrary files over the proof connection. Commit the coordinator changes, then fetch and check out that exact commit on both owners.

### Host key failure

Verify the new key out of band. Do not bypass the check. Remove a stale key only after confirming why it changed.

### Owner does not restart

Inspect `sin-harness/data/two-node/n2.log` on that owner. A fixture, plan, Bun version, or port conflict normally causes startup refusal.

### Port already occupied

The runner refuses to kill unrelated processes. Stop the process you own or use a clean host before trying again.
