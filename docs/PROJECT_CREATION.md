# Create projects for supported Inovance PLC models

The MCP does not contain a fixed AM600 controller or a hard-coded model list.
`create_project` uses the controller already present in an explicitly selected
template. This allows the same tool to create projects for any Inovance PLC
model that the installed InoProShop version and device packages support, once
a suitable registered template or known-good `.project` template is available.

1. Install the target model's official device package in InoProShop. Create or
   obtain a reference project for that exact controller and firmware. Store
   reusable `.project` files in `<workspace>/.templates/`. These vendor files
   are local inputs and are not distributed in this open-source repository.
2. Call `list_project_templates`. It searches registered IDE templates,
   installed template directories, and `<workspace>/.templates/` automatically.
   An optional `extraTemplateDir` can scan another workspace directory.
3. Call `create_project` with exactly one of `templatePath` (a `.project`
   within the workspace) or `templateName` (an IDE-registered template).
   The target file must not already exist. A `.projecttemplate` or
   `.projectarchive` entry from discovery cannot be copied as a `.project`;
   use a registered template name if supported or first create and save a
   reference `.project` in the IDE.
4. Read the new project structure and verify its root controller, order number,
   firmware, expansion modules, Application and task POU calls. Then write the
   complete code and compile the whole application once. Save, reopen and
   verify the device and task configuration again.

Example with a locally prepared template for the selected model:

```json
{
  "filePath": "New_Project/New_Project.project",
  "templatePath": ".templates/Selected_Model.project"
}
```

The `Selected_Model.project` name is illustrative. It must be a real file
containing the intended controller. For the AM600 investigation, see the
[specific example](AM600_PROJECT_CREATION.md). Use a separate, verified
template for AM401, AM402 and other models. Copying the AM600 template and
renaming the output file does not change its root controller.

The generated project is not validated merely because compilation succeeds.
The MCP cannot manufacture missing vendor device packages or guarantee every
catalog variant from a model name alone. Model coverage follows the installed
InoProShop version, available device descriptions and the templates supplied
by the operator.
