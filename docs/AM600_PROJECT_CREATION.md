# Creating an AM600 project without changing the controller

`create_project` copies or instantiates the selected template. The template
determines the controller. The old implicit fallback to `Standard.project`
created a CoDeSys soft PLC when the caller omitted both template arguments.
The current tool requires exactly one of `templatePath` and `templateName` and
refuses to overwrite an existing target project.

For an AM600 project, first place a known-good AM600 `.project` template inside
the configured workspace. The vendor sample and device description must be
installed locally; neither is included in this repository. Example MCP call:

```json
{
  "filePath": "New_AM600/New_AM600.project",
  "templatePath": ".templates/AM600_Template.project"
}
```

Both paths are confined to the configured workspace, including resolved
junctions. `templateName` is for a template registered in the target IDE; use
`list_project_templates` to inspect available names. Do not assume a template
named `Standard` selects AM600.

After creation, call `get_project_structure` and inspect the root device and
the installed hardware nodes. Then call `get_task_config` to verify every task
entry still names an existing POU. Renaming a POU now updates matching task
call nodes within the same Application and verifies their names before saving.
Compile the whole application after all source changes and inspect diagnostics.
Finally, save and reopen a disposable project to repeat the controller and task
checks. A clean compile alone does not prove that the task calls the intended POU.

The project used to investigate this issue was a local AM600 example. It was
not added to this repository. Offline tests exercise the MCP's safeguards, but
the updated rename and shutdown behavior still requires acceptance in the
installed InoProShop version before use on production projects.
