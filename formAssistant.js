/*  **JSON schema (examples)**

    Object‑key style:
    {
      "Special:BlankPage/form": {
        "title": "Demo survey",
        "instructions": "Please fill the survey. Fields marked required.",
        "targetPage": "User:L235/sandbox2",
        "prepend": false,
        "template": { "name": "User:L235/TestTemplate", "subst": true },
        "questions": [
          { "label": "Question A", "type": "text", "templateParam": "1", "default": "foo" },
          { "label": "Question B", "type": "textarea", "required": true, "templateParam": "2" },
          { "type": "heading", "text": "Choices" },
          { "label": "Question C", "type": "dropdown", "options": ["apples", "bananas"], "templateParam": "3", "default": "bananas" },
          { "label": "Question D", "type": "checkbox", "options": ["cats", "dogs"], "templateParam": "4", "default": ["cats"] },
          { "label": "Question E", "type": "radio", "options": ["noun", "verb"], "required": true, "templateParam": "5", "default": "verb" },
          { "label": "Section title", "type": "text", "required": true, "templateParam": "6" },
          { "type": "static", "html": "''Thanks for participating!''" }
        ]
      }
    }

    **Target page variables:**
    - {{USERNAME}} - Current user's username
    - {{FIELD:templateParam}} - Value from form field (use templateParam as identifier)
    
    **Form options:**
    - "prepend": true/false - Whether to prepend (true) or append (false, default) to target page
    
    Examples:
    - "targetPage": "User talk:{{USERNAME}}" - Posts to current user's talk page
    - "targetPage": "User:{{FIELD:1}}/requests" - Uses value from templateParam "1"
    - "prepend": true - Adds content to top of page instead of bottom
*/
/* global mw, $ */
(function () {
    var CONFIG_PAGE = 'User:L235/form-config.json';

    // ------------------------------------------------------------------
    // Cross‑browser CSS.escape polyfill (only if missing)
    if (!window.CSS || !CSS.escape) {
        (function (global) {
            var ESC_RE = /[\0-\u001F\u007F-\u009F\u00A0-\uFFFF]/g;
            var REPL = function (c) { return '\\' + c.charCodeAt(0).toString(16) + ' '; };
            global.CSS = global.CSS || {};
            global.CSS.escape = function (val) {
                return String(val).replace(ESC_RE, REPL).replace(/^(?:-?\d)/, '\\$&');
            };
        })(window);
    }

    mw.loader.using(['mediawiki.api', 'oojs-ui']).then(function () {
        var api = new mw.Api();

        /* ---------- internal‑field counter ------------------------ */
        var mfCounter = 0;

        /* ---------- helper: parse wikitext -> safe HTML -------------- */
        function parseWikitext(wt) {
            return api.post({
                action: 'parse',
                text: wt || '',
                contentmodel: 'wikitext',
                wrapoutputclass: ''
            }).then(function (d) {
                return d.parse.text['*'];
            }).catch(function () {
                // Never inject raw fallback – escape instead
                return $('<div>').text(wt || '').prop('outerHTML');
            });
        }

        /* ---------- helper: escape template parameters --------------- */
        function encodeParam(val) {
            // Ensure string, escape HTML special chars, preserve newlines
            return mw.html.escape(String(val || '')).replace(/\n/g, '&#10;');
        }

        /* ---------- 1. Load JSON config ------------------------------ */
        api.get({
            action: 'query', prop: 'revisions', titles: CONFIG_PAGE,
            rvprop: 'content', formatversion: 2
        }).then(function (data) {
            var page = data.query.pages[0];
            if (!page.revisions) {
                console.error('[formFiller.js] Config page missing or empty');
                return;
            }
            var raw = page.revisions[0].content;
            var cfg;
            try { cfg = JSON.parse(raw); }
            catch (e) { console.error('[formFiller.js] JSON parse error:', e); return; }

            var current = mw.config.get('wgPageName').replace(/_/g, ' ');
            var formCfg = matchForm(cfg, current);
            if (formCfg) renderForm(formCfg);
        }).fail(function (err) { console.error('[formFiller.js] API error:', err); });

        /* ---------- helper: find config for this page ---------------- */
        function matchForm(cfg, page) {
            if (Array.isArray(cfg)) return cfg.find(function (f) { return f.formPage === page; });
            if (cfg[page]) return cfg[page];
            return Object.values(cfg).find(function (f) { return f.formPage === page; });
        }

        /* ---------- 2. Render form ----------------------------------- */
        function renderForm(cfg) {
        	$('#firstHeading').empty();
            var $content = $('#mw-content-text').empty();
            if (cfg.title) $content.append($('<h2>').text(cfg.title));

            /* ---------- generate safe field names ----------------- */
            (cfg.questions || []).forEach(function (q) {
                q._fieldName = 'mf_' + (mfCounter++);
            });

            var promises = [];
            if (cfg.instructions) {
                promises.push(parseWikitext(cfg.instructions).then(function (html) { $content.append($(html)); }));
            }

            Promise.all(promises).then(function () {
                var $form = $('<form>').appendTo($content);
                (cfg.questions || []).forEach(function (q) { insertItem($form, q); });

                $form.append('<br>');
                var $submit = $('<input>').attr({ type: 'submit', value: 'Submit' });
                $form.append($submit);
                $form.on('submit', function (e) {
                    e.preventDefault();
                    submit($form, cfg, $submit);
                });
            });
        }

        /* ---------- insert question or static block ------------------ */
        function insertItem($form, q) {
            var safeName = q._fieldName;   // always defined for non‑static items

            switch (q.type) {
                case 'heading':
                    $form.append($('<h3>').text(q.text));
                    return;
                case 'static':
                case 'html':
                    var $ph = $('<div class="formfiller-placeholder"></div>');
                    $form.append($ph); // preserves ordering
                    parseWikitext(q.html || q.text || '').then(function (html) {
                        $ph.replaceWith($(html));
                    });
                    return;
            }

            var $label = $('<label>').text(q.label + (q.required ? ' (required)' : ''));
            var $field;

            switch (q.type) {
                case 'text':
                    $field = $('<input>').attr({ type: 'text', name: safeName, size: 40, value: q.default || '' });
                    break;
                case 'textarea':
                    $field = $('<textarea>').attr({ name: safeName, rows: 4, cols: 60 }).val(q.default || '');
                    break;
                case 'dropdown':
                    $field = $('<select>').attr('name', safeName);
                    (q.options || []).forEach(function (opt) {
                        var $o = $('<option>').val(opt).text(opt);
                        if (opt === q.default) $o.prop('selected', true);
                        $field.append($o);
                    });
                    break;
                case 'checkbox':
                    $field = $('<span>');
                    var defs = Array.isArray(q.default) ? q.default : (q.default ? [q.default] : []);
                    (q.options || []).forEach(function (opt) {
                        var $l = $('<label>');
                        var $cb = $('<input>').attr({ type: 'checkbox', name: safeName, value: opt });
                        if (defs.includes(opt)) $cb.prop('checked', true);
                        $l.append($cb, ' ', opt, '\u00A0');
                        $field.append($l);
                    });
                    break;
                case 'radio':
                    $field = $('<span>');
                    (q.options || []).forEach(function (opt) {
                        var $l = $('<label>');
                        var $rb = $('<input>').attr({ type: 'radio', name: safeName, value: opt });
                        if (q.required) $rb.attr('required', true);
                        if (opt === q.default) $rb.prop('checked', true);
                        $l.append($rb, ' ', opt, '\u00A0');
                        $field.append($l);
                    });
                    break;
                default:
                    console.warn('[formFiller.js] Unsupported field type:', q.type);
                    return;
            }

            /* ------------ accessibility annotations --------------- */
            var fieldId = safeName + '_input';
            $field.attr('id', fieldId);
            $label.attr('for', fieldId);
            if (q.required) {
                $field.attr({ required: true, 'aria-required': 'true' });
            }
            if (['checkbox', 'radio'].includes(q.type)) {
                $field.attr({ role: 'group', 'aria-labelledby': fieldId + '_lbl' });
                $label.attr('id', fieldId + '_lbl');
            }

            $form.append($label.append($field)).append('<br><br>');
        }

        /* ---------- helper: resolve target page variables ----------- */
        function resolveTargetPage(targetPage, formData) {
            if (!targetPage || typeof targetPage !== 'string') return targetPage;
            
            // Replace {{USERNAME}} with current user
            var resolved = targetPage.replace(/\{\{USERNAME\}\}/g, mw.config.get('wgUserName') || '');
            
            // Replace {{FIELD:fieldname}} with form field values
            resolved = resolved.replace(/\{\{FIELD:([^}]+)\}\}/g, function(match, fieldName) {
                return formData[fieldName] || match;
            });
            
            return resolved;
        }

        /* ---------- 3. Submission ------------------------------------ */
        function valueOf($form, q) {
            var sel = '[name="' + q._fieldName + '"]';
            switch (q.type) {
                case 'checkbox':
                    return $form.find(sel + ':checked').map(function () { return this.value; }).get().join(', ');
                case 'radio':
                    return $form.find(sel + ':checked').val() || '';
                default:
                    return ($form.find(sel).val() || '').trim();
            }
        }

        function submit($form, cfg, $submit) {
            // Collect all form data for target page resolution
            var formData = {};
            (cfg.questions || []).forEach(function (q) {
                if (q.templateParam) {
                    formData[q.templateParam] = valueOf($form, q);
                }
            });

            // Custom validation for required checkbox groups
            var missing = (cfg.questions || []).filter(function (q) {
                if (!q.required) return false;
                var val = valueOf($form, q);
                return !val; // empty string means nothing selected
            });

            if (missing.length) {
                alert('Please complete required fields: ' + missing.map(function (q) { return q.label; }).join(', '));
                return;
            }

            var params = (cfg.questions || []).filter(function (q) { return q.templateParam; })
                .map(function (q) { return '|' + q.templateParam + '=' + encodeParam(valueOf($form, q)); }).join('');
            var tpl = cfg.template.name || cfg.template;
            if (cfg.template && cfg.template.subst) tpl = 'subst:' + tpl;
            var wikitext = '\n{{' + tpl + params + '}}\n';

            // Resolve target page with variables
            var targetPage = resolveTargetPage(cfg.targetPage, formData);

            $submit.prop('disabled', true).val('Submitting…');
            
            // Determine edit parameters based on prepend option
            var editParams = {
                action: 'edit',
                title: targetPage,
                summary: cfg.editSummary || (cfg.prepend ? 'Prepend answers via [[User:L235/formFiller.js|formFiller.js]]' : 'Append answers via [[User:L235/formFiller.js|formFiller.js]]')
            };
            
            if (cfg.prepend) {
                editParams.prependtext = wikitext;
            } else {
                editParams.appendtext = wikitext;
            }
            
            api.postWithToken('csrf', editParams).done(function () {
                mw.notify('Saved!', { type: 'success' });
                $form[0].reset();
            }).fail(function (err) {
                console.error('[formFiller.js] Edit error:', err);
                mw.notify('Error: ' + err, { type: 'error', autoHide: false });
            }).always(function () {
                $submit.prop('disabled', false).val('Submit');
            });
        }
    });
})();
