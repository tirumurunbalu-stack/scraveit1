#!/bin/zsh
# Forced command for the iPhone Shortcuts SSH key (~/.ssh/authorized_keys).
# The Shortcut's script text picks the action; only the actions listed here can run.
# Anything else (including the old "Sign Scraveit" Shortcut) goes to the signing script, as before.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
setopt pipefail
REPO=/Users/balu/Desktop/2026-08-14/scraveit-deploy
CMD="${SSH_ORIGINAL_COMMAND:-}"
# First word = action (only this is logged). Anything after the first space is a value for the action.
ACTION="${CMD%% *}"
ACTION="${ACTION//[^a-z-]/}"
ARG=""
[[ "$CMD" == *" "* ]] && ARG="${CMD#* }"
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
  deploy-main-website)
    # www.scraveit.in (home, shop, partner website, short app links) — website/firebase.json
    cd "$REPO/website" || { echo "Website folder not found."; exit 1; }
    if firebase deploy --only hosting --project savrivo-app --non-interactive > /tmp/scraveit-phone-deploy.log 2>&1; then
      echo "Done ✓ www.scraveit.in deployed."
    else
      echo "Failed ✗"
      tail -n 6 /tmp/scraveit-phone-deploy.log
      exit 1
    fi
    ;;
  cashfree-client-id|cashfree-client-secret)
    # The value comes from the Shortcut's "Ask for Input" on standard input; it is never logged or echoed.
    NAME=CASHFREE_PAYOUT_${${ACTION#cashfree-}//-/_}
    NAME=${(U)NAME}
    VAL="$ARG"
    [ -n "${VAL//[$'\r\n\t ']/}" ] || VAL=$(cat)
    print -r -- "  value length=${#VAL}" >> "$HOME/.scraveit-phone-commands.log"
    VAL="${VAL//[$'\r\n\t ']/}"
    [ -n "$VAL" ] || { echo "Nothing reached the Mac. Set the SSH step's Input to the pasted text."; exit 1; }
    cd "$REPO" || { echo "Project folder not found."; exit 1; }
    if print -rn -- "$VAL" | firebase functions:secrets:set "$NAME" --project savrivo-app --data-file=- --non-interactive > /tmp/scraveit-phone-secret.log 2>&1; then
      echo "Saved ✓ $NAME (${#VAL} characters)"
    else
      echo "Failed ✗ $NAME"
      grep -iE "error" /tmp/scraveit-phone-secret.log | tail -n 3
      exit 1
    fi
    unset VAL
    ;;
  *)
    exec "$REPO/native_android/sign_four_ssh.sh"
    ;;
esac
