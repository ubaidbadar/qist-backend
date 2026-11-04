# Qist deployment on Hostinger

The existing checks run on every branch. Production deployment runs after those checks on pushes to main when the production environment variable QIST_DEPLOY_ENABLED is true.

On the VPS, create a dedicated SSH account named qist-deploy. Install a dedicated GitHub Actions public key in its authorized_keys with the restrict option. Keep the private key in GitHub Actions. The existing GitHub clone key serves the opposite direction.

Run these as root after provisioning the account. Copy scripts/qist-deploy.sh from the reviewed branch to the server first.

```bash
install -o root -g root -m 0755 qist-deploy.sh /usr/local/sbin/qist-deploy
install -d -o qist-deploy -g qist-deploy -m 0755 /srv/qist/releases
visudo -f /etc/sudoers.d/qist-deploy
```

Add this rule. The root-owned script validates its only argument.

```sudoers
qist-deploy ALL=(root) NOPASSWD: /usr/local/sbin/qist-deploy
```

For the initial migration, if current is still a real directory, preserve it as the rollback target. Run these during a deployment window.

```bash
cd /srv/qist
test -d current && test ! -L current && test ! -e initial-release &&
  mv -T current initial-release &&
  ln -s initial-release current
curl -fsS http://127.0.0.1:5001/health
```

Configure the production environment in GitHub:

- Variables: DEPLOY_HOST, DEPLOY_USER=qist-deploy, QIST_DEPLOY_ENABLED=true.
- Secrets: DEPLOY_SSH_KEY (the new private key), DEPLOY_KNOWN_HOSTS (the verified VPS host key entry for DEPLOY_HOST).

Enable deployment only after the SSH account, release directory, and activator are ready. After merging, confirm the deploy job passes and the public health endpoint responds. The activator restores the previous release if the service fails its local health check. Keep /etc/qist/api.env on the server.
