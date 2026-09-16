# Additional setup script

To run your own Bash script after installation and before verification:

```bash
bash provision.sh --with-local-patches "$HOME/my-dsh-setup.sh"
```

The file must exist. It runs in a separate Bash process, so exported
variables do not change the installer or future DSH sessions. A nonzero
exit status stops installation. Write the script so that running it again
does not duplicate settings or other changes.

This option is not needed for normal installation.
