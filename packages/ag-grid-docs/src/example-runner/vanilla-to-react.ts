import parser, { recognizedDomEvents } from './vanilla-src-parser';
import styleConvertor from './lib/convert-style-to-react';

function getFunctionName(code) {
    let matches = /function ([^\(]*)/.exec(code);
    return matches && matches.length === 2 ? matches[1].trim() : null;
}

function isInstanceMethod(instance: any, property: any) {
    const instanceMethods = instance.map(getFunctionName);
    return instanceMethods.filter(methodName => methodName === property.name).length > 0;
}

function convertFunctionToProperty(definition: string) {
    return definition.replace(/^function\s+([^\(\s]+)\s*\(([^\)]*)\)/, '$1 = ($2) => ');
}

function indexTemplate(bindings, componentFilenames, isDev, communityModules, enterpriseModules) {
    const imports = [];
    const propertyAssignments = [`modules: ${bindings.gridSettings.enterprise ? 'AllModules' : 'AllCommunityModules'}`];
    const componentAttributes = ["modules={this.state.modules}"];

    const instanceBindings = [];
    bindings.properties.filter(property => property.name != 'onGridReady').forEach(property => {
        if (componentFilenames.length > 0 && property.name === "components") {
            property.name = "frameworkComponents";
        }

        if (property.value === 'true' || property.value === 'false') {
            componentAttributes.push(`${property.name}={${property.value}}`);
        } else if (property.value === null) {
            componentAttributes.push(`${property.name}={this.${property.name}}`);
        } else {
            // for when binding a method
            // see javascript-grid-keyboard-navigation for an example
            // tabToNextCell needs to be bound to the react component
            if (isInstanceMethod(bindings.instance, property)) {
                instanceBindings.push(`this.${property.name}=${property.value}`);
            } else {
                propertyAssignments.push(`${property.name}: ${property.value}`);
                componentAttributes.push(`${property.name}={this.state.${property.name}}`);
            }
        }
    });

    const componentEventAttributes = bindings.eventHandlers.map(event => `${event.handlerName}={this.${event.handlerName}.bind(this)}`);

    componentAttributes.push('onGridReady={this.onGridReady}');
    componentAttributes.push.apply(componentAttributes, componentEventAttributes);

    if (bindings.gridSettings.enterprise) {
        imports.push('import {AllModules} from "@ag-enterprise/grid-all-modules";');
    } else {
        imports.push('import {AllCommunityModules} from "@ag-community/grid-all-modules";');
    }

    imports.push('import "@ag-community/grid-all-modules/dist/styles/ag-grid.css";');

    // to account for the (rare) example that has more than one class...just default to balham if it does
    const theme = bindings.gridSettings.theme || 'ag-theme-balham';
    imports.push(`import "@ag-community/grid-all-modules/dist/styles/${theme}.css";`);

    if (componentFilenames) {
        let titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

        componentFilenames.forEach(filename => {
            let componentName = titleCase(filename).split('.')[0];
            imports.push('import ' + componentName + ' from "./' + filename + '";');
        });
    }

    const additionalInReady = [];

    if (bindings.data) {
        let setRowDataBlock = bindings.data.callback;
        if (bindings.data.callback.indexOf('api.setRowData') !== -1) {
            if (propertyAssignments.filter(item => item.indexOf('rowData') !== -1).length === 0) {
                propertyAssignments.push('rowData: []');
            }
            if (componentAttributes.filter(item => item.indexOf('rowData') !== -1).length === 0) {
                componentAttributes.push('rowData={this.state.rowData}');
            }

            setRowDataBlock = bindings.data.callback.replace("params.api.setRowData(data);", "this.setState({ rowData: data });");
        }

        additionalInReady.push(`
            const httpRequest = new XMLHttpRequest();
            const updateData = (data) => ${setRowDataBlock};

            httpRequest.open('GET', ${bindings.data.url});
            httpRequest.send();
            httpRequest.onreadystatechange = () => {
                if (httpRequest.readyState === 4 && httpRequest.status === 200) {
                    updateData(JSON.parse(httpRequest.responseText));
                }
            };`);
    }

    if (bindings.onGridReady) {
        const hackedHandler = bindings.onGridReady.replace(/^\{|\}$/g, '');
        additionalInReady.push(hackedHandler);
    }

    if (bindings.resizeToFit) {
        additionalInReady.push('params.api.sizeColumnsToFit();');
    }

    const agGridTag = `<div
                id="myGrid"
                style={{
                    height: '${bindings.gridSettings.height}',
                    width: '${bindings.gridSettings.width}'}}
                    className="${bindings.gridSettings.theme}">
            <AgGridReact
                ${componentAttributes.join('\n')}
            />
            </div>`;

    let template = bindings.template ? bindings.template.replace('$$GRID$$', agGridTag) : agGridTag;

    recognizedDomEvents.forEach(event => {
        const jsEvent = 'on' + event[0].toUpperCase() + event.substr(1, event.length);
        const matcher = new RegExp(`on${event}="(\\w+)\\((.*?)\\)"`, 'g');

        template = template.replace(matcher, `${jsEvent}={this.$1.bind(this, $2)}`);
        template = template.replace(/, event\)/g, ")");
        template = template.replace(/, event,/g, ", ");
    });
    recognizedDomEvents.forEach(event => {
        // react events are case sensitive - could do something tricky here, but as there are only 2 events effected so far
        // I'll keep it simple
        const domEventsCaseSensitive = [
            { name: 'ondragover', replacement: 'onDragOver' },
            { name: 'ondragstart', replacement: 'onDragStart' }
        ];

        domEventsCaseSensitive.forEach(event => {
            template = template.replace(new RegExp(event.name, 'ig'), event.replacement);
        });
    });
    template = template.replace(/\(this\, \)/g, '(this)');

    template = template.replace(/<input type="(radio|checkbox|text)" (.+?)>/g, '<input type="$1" $2 />');
    template = template.replace(/<input placeholder(.+?)>/g, '<input placeholder$1 />');
    template = template.replace(/ class=/g, " className=");

    template = styleConvertor(template);

    const eventHandlers = bindings.eventHandlers.map(event => convertFunctionToProperty(event.handler));
    const externalEventHandlers = bindings.externalEventHandlers.map(handler => convertFunctionToProperty(handler.body));
    const instance = bindings.instance.map(body => convertFunctionToProperty(body));

    const style = bindings.gridSettings.noStyle ? '' : `style={{width: '100%', height: '100%' }}`;

    return `
'use strict'

import React, { Component } from "react";
import { render } from "react-dom";
import { AgGridReact } from "@ag-community/grid-react";
${imports.join('\n')}

class GridExample extends Component {
    constructor(props) {
        super(props);

        this.state = {
            ${propertyAssignments.join(',\n    ')}
        };

        ${instanceBindings.join(';\n    ')}
    }

    onGridReady = params => {
        this.gridApi = params.api;
        this.gridColumnApi = params.columnApi;
        ${additionalInReady.join('\n')}
    }

${[].concat(eventHandlers, externalEventHandlers, instance).join('\n\n   ')}

    render() {
        return (
            <div ${style}>
                ${template}
            </div>
        );
    }
}

${bindings.utils.join('\n')}

render(
    <GridExample></GridExample>,
    document.querySelector('#root')
)
`;
}

export function vanillaToReact(js, html, exampleSettings, componentFilenames, isDev, communityModules, enterpriseModules) {
    const bindings = parser(js, html, exampleSettings);
    return indexTemplate(bindings, componentFilenames, isDev, communityModules, enterpriseModules);
}

if (typeof window !== 'undefined') {
    (<any>window).vanillaToReact = vanillaToReact;
}
