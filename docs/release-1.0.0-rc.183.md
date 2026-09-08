# M-BOX 1.0.0-rc.183

Release-protection follow-up to rc.182. During external smoke verification a transient /staff/live timeout triggered rollback, exposing that activation wrote previousIdentityComplete as numeric 1 while rollback accepted only true/false. The gate exited before traffic/container mutation; rc.182 remained healthy and an unchanged smoke/browser rerun passed.

This candidate accepts only legacy 0/1 or canonical false/true, emits canonical JSON booleans for new deployment manifests, and adds regression coverage through the real rollback script with mocked infrastructure. No credentials, production financial history or schema changed. The database stays at 162; application and Mini Program source are identical to rc.182. Do not treat mocked rollback as a live rollback drill.

Publish an immutable new release; do not patch rc.182 scripts or deployment manifests in place. WeChat rc.182 upload confirmation remains a separate pending task and must not be duplicated. Real payment, phone and operational acceptance gates remain open.
