// The credential inputs for one REST auth method — the view half of
// @ui/utils/crawlerCredentials, which already owns the matching logic
// (canSubmitCredentials / buildCredentialFields) for the same method names.
//
// Each wizard was rendering its own copy of these blocks, so the same
// username/password/token/OAuth markup existed three times over and every new
// crawler added a fourth. Driven by a declarative table here instead, so a
// wizard names its methods and gets the right fields.
import { SECRET_PLACEHOLDER } from '@ui/utils/crawlerCredentials';
import { CrawlerField } from './wizardFields';

// field key → how to render it. `secret` fields show the stored-value
// placeholder while editing, because a blank one means "keep what is vaulted".
const FIELD_SPECS = {
  username:      { label: 'Username' },
  password:      { label: 'Password', secret: true },
  apiToken:      { label: 'API Token', secret: true, mono: true },
  cookieString:  { label: 'Cookie String', secret: true, mono: true, rows: 3 },
  tokenEndpoint: { label: 'Token Endpoint URL', mono: true, placeholder: 'https://idp.example.com/oauth2/token' },
  clientId:      { label: 'Client ID', mono: true },
  clientSecret:  { label: 'Client Secret', secret: true },
};

// Which fields each auth method needs, in render order. Mirrors
// buildCredentialFields() in @ui/utils/crawlerCredentials — keep the two in step.
// Not exported: a component file that also exports a non-component breaks fast
// refresh (react-refresh/only-export-components), and the rendered output is
// what the tests assert anyway.
const CREDENTIAL_FIELDS_BY_METHOD = {
  BasicAuth:    ['username', 'password'],
  FormCookie:   ['username', 'password'],
  ApiToken:     ['apiToken'],
  CookieString: ['cookieString'],
  OAuth2CC:     ['tokenEndpoint', 'clientId', 'clientSecret'],
  // username/password first for ROPC: that is the order the wizards rendered
  // them in, and the order an operator fills them in.
  OAuth2ROPC:   ['username', 'password', 'tokenEndpoint', 'clientId', 'clientSecret'],
};

// `values` is the wizard's credential state keyed by field name; `onChange`
// receives (fieldName, value). An unknown auth method renders nothing rather
// than throwing — the same "no gate" stance canSubmitCredentials takes.
// `placeholders` overrides a field's placeholder per crawler (an Omada token
// endpoint reads differently from a generic one). `extras` hangs extra UI under
// a named field — Omada's "how do I get the cookie string" help lives there.
export default function CredentialFields({ authMethod, values, onChange, isEdit, placeholders = {}, extras = {} }) {
  const fields = CREDENTIAL_FIELDS_BY_METHOD[authMethod] || [];
  return (
    <>
      {fields.map(name => {
        const spec = FIELD_SPECS[name];
        const ownPlaceholder = placeholders[name] ?? spec.placeholder;
        return (
          <CrawlerField
            key={name}
            label={spec.label}
            type={spec.secret ? 'password' : 'text'}
            mono={spec.mono}
            rows={spec.rows}
            value={values[name] || ''}
            onChange={v => onChange(name, v)}
            placeholder={spec.secret && isEdit ? SECRET_PLACEHOLDER : ownPlaceholder}
          >
            {extras[name]}
          </CrawlerField>
        );
      })}
    </>
  );
}
