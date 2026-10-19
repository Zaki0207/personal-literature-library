# Desktop delivery

Follow the user's RTK instructions for shell commands (`rtk proxy` for commands without a dedicated RTK wrapper).

For macOS desktop changes intended for this user's daily use, finish the relevant checks and run `rtk proxy npm run desktop:update`. This builds the release, validates the actual application with an isolated library, requests a normal quit of any old application, installs to the stable Applications location, and starts the new version. Do not leave installation or quitting the old version as manual steps for the user.

The user has authorized this local update workflow. Keep the existing save-before-quit protection: if a draft or failed save prevents quitting, report the concrete blocker and leave the running application intact. Never force-kill it or overwrite an application that is still running. Do not write test fixtures to the user's real library or make paid AI requests during validation.
