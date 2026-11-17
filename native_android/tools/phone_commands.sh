#!/bin/zsh
# Forced command for the iPhone Shortcuts SSH key (~/.ssh/authorized_keys).
# The Shortcut's script text picks the action; only the actions listed here can run.
# Anything else (including the old "Sign Scraveit" Shortcut) goes to the signing script, as before.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
setopt pipefail
REPO=/Users/balu/Desktop/2026-08-14/scraveit-deploy
ACTION="${SSH_ORIGINAL_COMMAND:-}"
ACTION="${ACTION//[^a-z-]/}"
print -r -- "$(date '+%Y-%m-%d %H:%M:%S') ${ACTION:-sign}" >> "$HOME/.scraveit-phone-commands.log"

case "$ACTION" in
  deploy-admin-website)
    cd "$REPO" || { echo "Project folder not found."; exit 1; }
    if firebase deploy --only hosting --project savrivo-app --non-interactive > /tmp/scraveit-phone-deploy.log 2>&1; then
      echo "Done ✓ Admin website deployed."
      grep -E "Hosting URL" /tmp/scraveit-phone-deploy.log | tail -n 1
    else
      echo "Failed ✗"
      tail -n 6 /tmp/scraveit-phone-deploy.log
      exit 1
    fi
    ;;
  *)
    exec "$REPO/native_android/sign_four_ssh.sh"
    ;;
esac
