import assert from 'assert';
import { EntityUtils } from 'genie-toolkit';
import ThingTalk, { Type } from 'thingtalk';
import { Ast, Syntax } from "thingtalk";
import WikidataUtils from '../utils/wikidata';
import { 
    ENTITY_PREFIX, 
    PROPERTY_PREFIX, 
    LABEL, 
    DATETIME, 
    TP_DEVICE_NAME,
    PROPERTY_PREDICATE_PREFIX,
    PROPERTY_QUALIFIER_PREFIX,
    PROPERTY_STATEMENT_PREFIX
} from '../utils/wikidata';
import { PatternConverter } from './helpers/pattern-convertor';
import { RuleBasedPreprocessor } from './helpers/rule-based-preprocessor';

const ENTITY_VARIABLES = ['x', 'y', 'z'];
const PREDICATE_VARIABLES = ['p', 'q', 'r'];

function convertOp(op : string) {
    // HACK
    return ['>=', '<='].includes(op) ? op[0] : op; 
}

// HACK: replace domain with other domain due to wikidata artifacts
const DOMAIN_MAP : Record<string, string> = {
    // replace "book" to "literary work", as book is not commonly used in wikidata
    'Q571': 'Q7725634'
};

class TableInfoVisitor extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    subject ?: string;
    domainName ?: string;

    constructor(converter : ThingTalkToSPARQLConverter) {
        super();
        this._converter = converter;
    }

    visitChainExpression(node : ThingTalk.Ast.ChainExpression) : boolean {
        if (node.expressions.length > 1)   
            throw new Error(`Not supported: chain expression`);
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        if (node.name === 'id' && node.value instanceof Ast.EntityValue)
            this.subject = `<${ENTITY_PREFIX}${node.value.value}>`;
        if (node.name === 'instance_of' && node.value instanceof Ast.EntityValue) 
            this.domainName = node.value.value!;
        return true;
    }

    visitInvocation(node : ThingTalk.Ast.Invocation) : boolean {
        if (node.channel !== 'entity') {
            if (this._converter.humanReadableInstanceOf) {
                this.domainName = node.channel.replace(/_/g, ' ');
            } else {
                const query = this._converter.class.getFunction('query', node.channel);
                this.domainName = (query?.getImplementationAnnotation('wikidata_subject') as string[])[0];
            } 
        }
        return true;
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        return false;
    }
}

interface QualifiedPredicate {
    property : string;
    predicateVariable : string;
}


class TripleGenerator extends Ast.NodeVisitor {
    private _converter : ThingTalkToSPARQLConverter;
    private _subject : string;
    private _subjectProperties : string[]; 
    private _target_projection : string|null;
    private _inPredicate : QualifiedPredicate|null;
    private _statements : string[];

    constructor(converter : ThingTalkToSPARQLConverter, 
                subject : string, 
                subjectProperties : string[], // list properties available for the subject 
                projection : string|null, 
                domain : string|null,
                qualifiedPredicate : QualifiedPredicate|null = null) {
        super();
        this._converter = converter;
        this._subject = subject; // either a variable with ? prefix, or a full path QID
        this._subjectProperties = subjectProperties;
        this._target_projection = projection;
        this._inPredicate = qualifiedPredicate;
        this._statements = [];
        if (subject.startsWith('?') && domain)
            this._statements.push(this._triple('P31', domain));
    }

    get statements() : string[] {
        return this._statements;
    }

    private _node(node : string) : string {
        if (typeof node !== 'string')
            console.log('HHH');
        if (node.startsWith('?'))
            node = node.slice('?'.length);
        if ([...ENTITY_VARIABLES, ...PREDICATE_VARIABLES].includes(node))
            return '?' + node;
        if (this._converter.kb.isEntity(node))
            return `<${ENTITY_PREFIX}${node}>`;
        assert(node.startsWith(`<${ENTITY_PREFIX}`));
        return node;
    }

    private _edge(property : string, value : string) : string {
        let prefix = PROPERTY_PREFIX;
        if (this._inPredicate) {
            if (property === 'value') {
                property = this._inPredicate.property;
                prefix = PROPERTY_STATEMENT_PREFIX;
            } else {
                prefix = PROPERTY_QUALIFIER_PREFIX;
            }
        } else if (PREDICATE_VARIABLES.includes(value)) {
            prefix = PROPERTY_PREDICATE_PREFIX;
        }

        const predicate = `<${prefix}${property}>`;

        // SPECIAL CASES: 
        // P131, located in admin entity, always do property path "+"
        if (property === 'P131')
            return predicate + '+';
        // P31, instance of, always add optional subclass of
        if (property === 'P31')
            return `<${prefix}P31>/<${prefix}P279>*`;
        // P276, location -> location | coordinate location (only if the value is a variable)
        if (property === 'P276' && !this._converter.kb.isEntity(value)) 
            return `(<${prefix}P276>|<${prefix}P625>)`;
        // P161, cast member -> cast member | voice actor
        if (property === 'P161')
            return `(<${prefix}P161>|<${prefix}P725>)`; 
        return predicate;
    }

    private _triple(property : string, value : string, subject ?: string) {
        assert(property && value);
        // this._subject: either a variable with ? prefix, or a full path QID
        // subject: either a variable WITHOUT ? prefix, or a simple QID
        const s = subject ? this._node(subject) : this._subject;
        const p = this._edge(property, value);
        const v = this._node(value);

        if (property === 'P31' && value === 'Q7275')
            return `{ ${s} ${p} ${v}. } UNION { ${s} ${p} ${this._node('Q475050')}. }`;
        if (property === 'P31' && value in DOMAIN_MAP)
            value = DOMAIN_MAP[value];
        return `${s} ${p} ${v}.`;
    }

    private _toStatements(property : string, operator : string, value : Ast.Value, subject ?: string, subjectProperties ?: string[]) : string[] {
        subject = subject ?? this._subject;
        subjectProperties = subjectProperties ?? this._subjectProperties;
        const statements : string[] = [];
        // id string filter
        if (property === 'id' && operator === '=~') {
            assert(value instanceof Ast.StringValue);
            const variable = this._converter.getEntityVariable();
            statements.push(`${subject} <${LABEL}> ?${variable}.`);
            statements.push(`FILTER(LCASE(STR(?${variable})) = "${value.value}").`);
            return statements;
        }

        // skip all other filters on id and instance_of
        if (property === 'id' || property === 'instance_of')
            return [];

        // filter on aggregation result
        if (property === 'count') {
            assert(value instanceof Ast.NumberValue);
            // check if any node satisfying the filters exists, no need to do anything
            if (value.value === 1 && operator === '>=')
                return [];
            throw new Error('Unsupported aggregation');
        } 

        // filter on point in time 
        if (property === 'point_in_time') {
            assert(value instanceof Ast.DateValue && value.value instanceof Date);
            const date = new Date(value.value);
            if (operator === '==' && date.getUTCMonth() === 0 && date.getUTCDate() === 1) {
                const beginValue = `"${date.toISOString()}"^^<${DATETIME}>`;
                date.setUTCFullYear(date.getUTCFullYear() + 1);
                const endValue = `"${date.toISOString()}"^^<${DATETIME}>`;
                // if (this._subject.startsWith('?')) 
                //    throw Error('TODO: generic filter on time for search questions');
                if (subjectProperties.includes('P580')) {
                    const variable1 = this._converter.getEntityVariable('P580');
                    statements.push(this._triple('P580', variable1, subject));
                    const variable2 = this._converter.getEntityVariable('P582');
                    statements.push(this._triple('P582', variable2, subject));
                    statements.push(`FILTER((${variable1} <= ${endValue}) && (${variable2} >= ${beginValue}))`);
                } else {
                    const variable = this._converter.getEntityVariable('P585');
                    statements.push(this._triple('P585', variable, subject));
                    statements.push(`FILTER((${variable} >= ${beginValue}) && (${variable} <= ${endValue}))`);
                }
                return statements;
            }
        }

        // generic atom filters 
        const p = property === 'value' && this._inPredicate ? property : this._converter.getWikidataProperty(property);
        if (value instanceof Ast.EntityValue) {
            statements.push(this._triple(p, value.value!, subject));
        } else if (value instanceof Ast.NumberValue) {
            const variable = this._converter.getEntityVariable(p);
            statements.push(this._triple(p, variable, subject));
            statements.push(`FILTER(?${variable} ${convertOp(operator)} ${value.value}).`);
        } else if (value instanceof Ast.DateValue) {
            const date = (value.toJS() as Date).toISOString();
            const variable = this._converter.getEntityVariable(p);
            statements.push(this._triple(p, variable, subject));
            statements.push(`FILTER(?${variable} ${convertOp(operator)} "${date}"^^<${DATETIME}>).`);
        } else if (value instanceof Ast.StringValue) {
            const str = value.value;
            const variable = this._converter.getEntityVariable(p);
            statements.push(this._triple(p, variable, subject));
            statements.push(`?${variable} <${LABEL}> "${str}"@en.`);
        } else if (value instanceof Ast.EnumValue) {
            if (value.value === 'male')
                this._statements.push(this._triple(p, 'Q6581097', subject));
            else if (value.value === 'female')
                this._statements.push(this._triple(p, 'Q6581072', subject));
            else
                throw new Error('Unsupported enum value: ' + value);
        } else {
            throw new Error('Unsupported atom filter');
        }
        
        return statements;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        assert(node.args.length === 1 || node.computations.length === 1);
        if (node.args.length === 1) {
            const arg = node.args[0];
            if (arg === 'id')
                return true;
            if (arg.includes('.')) {
                const [property, qualifier] = arg.split('.');
                const p = this._converter.getWikidataProperty(property);
                const q = this._converter.getWikidataProperty(qualifier);
                const predicateVariable = this._converter.getPredicateVariable();
                const valueVariable = this._converter.getEntityVariable();
                if (arg === this._target_projection) 
                    this._converter.setResultVariable(`?${valueVariable}`);
                this._statements.push(`${this._subject} <${PROPERTY_PREDICATE_PREFIX}${p}> ?${predicateVariable}.`);
                this._statements.push(`?${predicateVariable} <${PROPERTY_QUALIFIER_PREFIX}${q}> ?${valueVariable}.`);
            } else {
                const p = this._converter.getWikidataProperty(arg);
                const v = this._converter.getEntityVariable(p);
                if (arg === this._target_projection) 
                    this._converter.setResultVariable(`?${v}`);
                this._statements.push(this._triple(p, v));
            }
        } else {
            const computation = node.computations[0];
            if (computation instanceof Ast.FilterValue) {
                if (!(computation.filter instanceof Ast.ComparisonSubqueryBooleanExpression))
                    return true;
                if (!(computation.filter.lhs instanceof Ast.VarRefValue && computation.filter.lhs.name === 'value'))
                    return true;
                assert(computation.value instanceof Ast.VarRefValue);
                const p = this._converter.getWikidataProperty(computation.value.name);
                const v = this._converter.getEntityVariable(p);
                this._statements.push(this._triple(p, v));
                const tripleGenerator = new TripleGenerator(this._converter, `?${v}`, this._subjectProperties, null, null, null);
                computation.filter.visit(tripleGenerator);
                this._statements.push(...tripleGenerator.statements);

                if (computation.prettyprint() === this._target_projection)
                    this._converter.setResultVariable(`?${v}`);
                return false;
            }
        }
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        assert(node.projections.length === 1);
        const proj = node.projections[0];
        if (proj.value instanceof Ast.Value)    
            throw new Error('Not supported: value in projection');
        
        const v = this._converter.getEntityVariable(proj.prettyprint());
        if (proj.prettyprint() === this._target_projection)
            this._converter.setResultVariable(`?${v}`);
        
        if (Array.isArray(proj.value)) {
            const path : string[] = [];
            for (const elem of proj.value) {
                const p = this._converter.getWikidataProperty(elem.property);
                path.push(elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : this._edge(p, v));
            }
            this._statements.push(`${this._subject} ${path.join('/')} ?${v}.`);
        } else {
            const p = this._converter.getWikidataProperty(proj.value);
            this._statements.push(this._triple(p, v, undefined));
        }     

        if (proj.types.length > 0) {
            const statements = proj.types.map((t) => {
                const type = (t as Type.Entity).type.slice(TP_DEVICE_NAME.length + 1).replace(/_/g, ' ');
                const domain = this._converter.getWikidataDomain(type)!;
                return this._triple('P31', domain, v);
            });
            if (statements.length === 1)
                this._statements.push(statements[0]);
            else 
                this._statements.push(`{ ${statements.join(' UNION ')} }`);
        }
        return true;
    }

    visitBooleanQuestionExpression(node : ThingTalk.Ast.BooleanQuestionExpression) : boolean {
        this._converter.setIsBooleanQuestion();
        return true;
    }

    visitNotBooleanExpression(node : ThingTalk.Ast.NotBooleanExpression) : boolean {
        if (node.expr instanceof Ast.AtomBooleanExpression) {
            if (node.expr.operator === '==' && node.expr.value instanceof Ast.NullValue) {
                const property = node.expr.name;
                const p = this._converter.getWikidataProperty(property);
                const v = this._converter.getEntityVariable(p);
                this._statements.push(this._triple(p, v));
                return false; 
            } 
        }
        throw new Error('Unsupported negative boolean expression');
    }

    visitOrBooleanExpression(node : ThingTalk.Ast.OrBooleanExpression) : boolean {
        const operands = [];
        for (const booleanExpression of node.operands) {
            const tripleGenerator = new TripleGenerator(this._converter, this._subject, this._subjectProperties, null, null);
            booleanExpression.visit(tripleGenerator);
            operands.push('{ ' + tripleGenerator.statements.join(' ') + ' }'); 
        }
        this._statements.push(operands.join(' UNION '));
        return false;     
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        const statements = this._toStatements(node.name, node.operator, node.value);
        this._statements.push(...statements);
        return true;
    }

    visitComputeBooleanExpression(node : ThingTalk.Ast.ComputeBooleanExpression) : boolean {
        if (node.lhs instanceof Ast.Value.Computation) {
            if (node.lhs.op === 'count') {
                const property = (node.lhs.operands[0] as Ast.VarRefValue).name;
                const p = this._converter.getWikidataProperty(property);
                const op = convertOp(node.operator); 
                const value = (node.rhs as Ast.NumberValue).value;
                const variable = this._converter.getEntityVariable(p);
                this._statements.push(this._triple(p, variable));
                if (!(node.operator === '>=' && value === 1)) // this means it is just checking if anything exists, no need to use having clause
                    this._converter.addHaving(`COUNT(?${variable}) ${op} ${value}`);
                return true;
            }
        } else if (node.lhs instanceof Ast.Value.Filter) {
            const property = (node.lhs.value as Ast.VarRefValue).name;
            const predicate = this._createQualifier(property);
            assert(node.operator === 'contains' || node.operator === '==');
            // update subject properties to qualifiers of the predicate
            const subjectProperties = this._subjectProperties.filter((p) => {
                return p.startsWith(predicate.property + '.');
            }).map((p) => {
                return p.slice(predicate.property.length + 1);
            });
            this._statements.push(...this._toStatements(property, node.operator, node.rhs, predicate.predicateVariable, subjectProperties));
            const tripleGenerator = new TripleGenerator(this._converter, `?${predicate.predicateVariable}`, subjectProperties, null, null, predicate);
            node.lhs.filter.visit(tripleGenerator);
            this._statements.push(...tripleGenerator.statements);  
            return true; 
        }
        throw new Error('Unsupported compute boolean expression: ' + node.prettyprint());
    }

    visitIndexExpression(node : ThingTalk.Ast.IndexExpression) : boolean {
        assert(node.indices.length === 1 && (node.indices[0] as Ast.NumberValue).value === 1);
        this._converter.setLimit(1);
        return true;
    }

    visitSliceExpression(node : ThingTalk.Ast.SliceExpression) : boolean {
        assert((node.base as Ast.NumberValue).value === 1);
        this._converter.setLimit((node.limit as Ast.NumberValue).value);
        return true;
    }

    visitSortExpression(node : ThingTalk.Ast.SortExpression) : boolean {
        const property = (node.value as Ast.VarRefValue).name;
        const p = this._converter.getWikidataProperty(property);
        const variable = this._converter.getEntityVariable(p);
        this._statements.push(this._triple(p, variable));
        this._converter.setOrder({ variable : '?' + variable, direction: node.direction });
        return true;
    }

    visitAggregationExpression(node : ThingTalk.Ast.AggregationExpression) : boolean {
        if (node.operator === 'count' && node.field === '*') {
            this._converter.setAggregation(node.operator, this._subject.slice('?'.length));
        } else {
            const property = this._converter.getWikidataProperty(node.field);
            const v = this._converter.getEntityVariable(node.field);
            this._converter.setAggregation(node.operator, v);
            this._statements.push(this._triple(property, v));
        }
        return true;
    }

    visitPropertyPathBooleanExpression(node : ThingTalk.Ast.PropertyPathBooleanExpression) : boolean {
        const v = (node.value as Ast.EntityValue).value!;
        const predicate = node.path.map((elem) => {
            const p = this._converter.getWikidataProperty(elem.property);
            return elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : this._edge(p, v);
        }).join('/'); 
        this._statements.push(`${this._subject} ${predicate} ${this._node(v)}.`);
        return true;
    }

    // qualifier
    visitFilterValue(node : ThingTalk.Ast.FilterValue) : boolean {
        assert(node.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifier(node.value.name);
        const entityVariable = this._converter.getEntityVariable();
        this._statements.push(`?${predicate.predicateVariable} <${PROPERTY_STATEMENT_PREFIX}${predicate.property}> ?${entityVariable}.`);
        // update subject properties to qualifiers of the predicate
        const subjectProperties = this._subjectProperties.filter((p) => {
            return p.startsWith(predicate.property + '.');
        }).map((p) => {
            return p.slice(predicate.property.length + 1);
        });
        const tripleGenerator = new TripleGenerator(this._converter, `?${predicate.predicateVariable}`, subjectProperties, null, null, predicate);
        node.filter.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.statements);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(`?${entityVariable}`);
        return false;
    }

    visitArrayFieldValue(node : ThingTalk.Ast.ArrayFieldValue) : boolean {
        assert(node.value instanceof Ast.FilterValue && node.value.value instanceof Ast.VarRefValue);
        const predicate = this._createQualifier(node.value.value.name);
        let fieldVariable;
        if (typeof node.field === 'string') {
            const field = this._converter.getWikidataProperty(node.field);
            fieldVariable = this._converter.getEntityVariable(field);
            this._statements.push(`?${predicate.predicateVariable} <${PROPERTY_QUALIFIER_PREFIX}${field}> ?${fieldVariable}.`);
        } else {
            fieldVariable = this._converter.getEntityVariable();
            const path = [];
            assert(!node.field[0].quantifier);
            path.push(`<${PROPERTY_QUALIFIER_PREFIX}${this._converter.getWikidataProperty(node.field[0].property)}>`);
            node.field.slice(1).forEach((elem) => {
                const p = this._converter.getWikidataProperty(elem.property);
                path.push('/');
                path.push(elem.quantifier ? `<${PROPERTY_PREFIX}${p}>${elem.quantifier}` : `<${PROPERTY_PREFIX}${p}>`);
            });
            this._statements.push(`?${predicate.predicateVariable} ${path.join('')} ?${fieldVariable}.`);
        }
        // update subject properties to qualifiers of the predicate
        const subjectProperties = this._subjectProperties.filter((p) => {
            return p.startsWith(predicate.property + '.');
        }).map((p) => {
            return p.slice(predicate.property.length + 1);
        });
        
        const tripleGenerator = new TripleGenerator(this._converter, `?${predicate.predicateVariable}`, subjectProperties, null, null, predicate);
        node.value.filter.visit(tripleGenerator);
        this._statements.push(...tripleGenerator.statements);

        if (node.prettyprint() === this._target_projection)
            this._converter.setResultVariable(`?${fieldVariable}`);
        return false;
    }

    private _createQualifier(property : string) : QualifiedPredicate {
        const p = this._converter.getWikidataProperty(property);
        const predicateVariable = this._converter.getPredicateVariable();
        this._statements.push(this._triple(p, predicateVariable));
        return {
            property : p,
            predicateVariable
        };
    }

    visitComparisonSubqueryBooleanExpression(node : ThingTalk.Ast.ComparisonSubqueryBooleanExpression) : boolean {
        assert(node.lhs instanceof Ast.VarRefValue);

        let filterVariable;
        if (node.lhs.name === 'id' || node.lhs.name === 'value') {
            filterVariable = this._subject.slice('?'.length);
        } else {
            const filterProperty = this._converter.getWikidataProperty(node.lhs.name);
            filterVariable = this._converter.getEntityVariable(filterProperty);
            this._statements.push(this._triple(filterProperty, filterVariable));
        }

        // set variable map for the subquery (do not use existing mapping)
        const variableMap : Record<string, string> = {};
        let projection  = node.rhs instanceof Ast.ProjectionExpression ? node.rhs.args[0] : 'id';
        if (projection === 'id') {
            variableMap[projection] = filterVariable;
        } else {
            projection = this._converter.getWikidataProperty(projection);
            if (node.lhs.name === 'id')
                variableMap[projection] = filterVariable;
            else
                variableMap[projection] = this._converter.getEntityVariable();
        }
        
        if (node.operator === '==' || node.operator === 'contains' || node.operator === 'in_array') {
            const statements = this._converter.convertExpression(node.rhs.optimize(), this._subjectProperties, false, variableMap);
            this._statements.push(...statements);
        } else if (node.operator === '>=' || node.operator === '<=' ) {
            const statements = this._converter.convertExpression(node.rhs.optimize(), this._subjectProperties, false, variableMap);
            this._statements.push(...statements);
            this._statements.push(`FILTER(?${filterVariable} ${node.operator[0]} ?${variableMap[projection]}).`);
        } else {
            throw new Error('Unsupported operator for subquery: ' + node.operator);
        }
        return false;
    }
}

interface Entity {
    value : string,
    name : string,
    canonical : string
}

interface Order {
    variable : string, 
    direction : 'asc' | 'desc'
}

interface Aggregation {
    operator : string;
    variable : string;
}

function aggregationToString(agg : Aggregation) {
    if (agg.operator === 'count')
        return `(COUNT(DISTINCT ?${agg.variable}) as ?count)`;
    else 
        return `(${agg.operator.toUpperCase()}(?${agg.variable}) as ?${agg.operator})`;
}

interface ThingTalkToSPARQLConverterOptions {
    locale : string,
    timezone ?: string,
    cache : string,
    save_cache : boolean,
    bootleg : string,
    human_readable_instance_of : boolean
}
export default class ThingTalkToSPARQLConverter {
    private _classDef : Ast.ClassDef;
    private _locale : string;
    private _timezone ?: string;
    private _kb : WikidataUtils;
    private _preprocessor : RuleBasedPreprocessor;
    private _patternConverter : PatternConverter;
    private _propertyMap : Record<string, string>;
    private _domainMap : Record<string, string>;
    private _variableMap : Record<string, string>;

    private _entityVariableCount : number;
    private _predicateVariableCount : number;

    private _resultVariable : string|null;
    private _isBooleanQuestion : boolean;
    private _statements : string[];
    private _having : string[];
    private _order : Order|null;
    private _limit : number|null;
    private _aggregation : Aggregation|null;
    private _humanReadableInstanceOf : boolean;

    constructor(classDef : Ast.ClassDef, domains : Entity[], options : ThingTalkToSPARQLConverterOptions) {
        this._classDef = classDef;
        this._locale = options.locale;
        this._timezone = options.timezone;

        this._kb = new WikidataUtils(options.cache, options.bootleg, options.save_cache);
        this._preprocessor = new RuleBasedPreprocessor(this._kb);
        this._patternConverter = new PatternConverter();
        this._propertyMap = { "P31" : "instance_of" };
        for (const property of this._classDef.queries['entity'].iterateArguments()) {
            const qid = property.getImplementationAnnotation('wikidata_id') as string;
            this._propertyMap[property.name] = qid;
            const elemType = property.type instanceof Type.Array ? property.type.elem : property.type;
            if (elemType instanceof Type.Compound) {
                for (const field in elemType.fields) {
                    if (field === 'value')
                        continue;
                    const qid = elemType.fields[field].getImplementationAnnotation('wikidata_id') as string;
                    this._propertyMap[field] = qid;
                }
            }
        }
        this._domainMap = { 'art museum' : 'Q207694' };
        for (const domain of domains) {
            if (options.human_readable_instance_of) {
                const qid = domain.name.match(/Q[0-9]+/g)![0];
                this._domainMap[domain.value] = qid;
                this._domainMap[qid] = qid;
            } else {
                this._domainMap[domain.canonical] = domain.value;
            }
        }
        this._variableMap = {};

        this._humanReadableInstanceOf = options.human_readable_instance_of;

        this._entityVariableCount = 0;
        this._predicateVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._order = null;
        this._limit = null;
        this._aggregation = null;
    }

    get class() {
        return this._classDef;
    }

    get kb() {
        return this._kb;
    }

    get humanReadableInstanceOf() {
        return this._humanReadableInstanceOf;
    }

    getEntityVariable(property ?: string) : string {
        if (!property)
            return ENTITY_VARIABLES[this._entityVariableCount ++];
        if (property in this._variableMap) 
            return this._variableMap[property];
        this._variableMap[property] = ENTITY_VARIABLES[this._entityVariableCount ++];
        return this._variableMap[property];
    }

    getPredicateVariable() : string {
        return PREDICATE_VARIABLES[this._predicateVariableCount ++];
    }

    getWikidataProperty(property : string) : string {
        return this._propertyMap[property];
    }

    getWikidataDomain(domain : string) : string|null {
        if (domain in this._domainMap)
            return this._domainMap[domain];
        if (this._kb.isEntity(domain))
            return domain;
        throw new Error('Unknown domain: ' + domain);
    }

    addStatement(statement : string) {
        if (!this._statements.includes(statement))
            this._statements.push(statement);
    }

    addHaving(having : string) {
        this._having.push(having);
    }

    setIsBooleanQuestion() {
        this._isBooleanQuestion = true;
    }

    setResultVariable(variable : string) {
        this._resultVariable = variable;
    }

    setOrder(order : Order) {
        this._order = order;
    }

    setLimit(index : number) {
        this._limit = index;
    }

    setAggregation(operator : string, variable : string) {
        this._aggregation = { operator, variable };
    }

    private _reset() {
        this._entityVariableCount = 0;
        this._predicateVariableCount = 0;
        this._statements = [];
        this._having = [];
        this._order = null;
        this._limit = null;
        this._resultVariable = null;
        this._isBooleanQuestion = false;
        this._aggregation = null;
        this._variableMap = {};
    }

    private _targetProjectionName(ast : Ast.Expression) {
        if (ast instanceof Ast.ProjectionExpression) {
            assert(ast.args.length === 1 || ast.computations.length === 1);
            if (ast.args.length === 1) 
                return ast.args[0];
            if (ast.computations.length === 1)
                return ast.computations[0].prettyprint();
        }
        if (ast instanceof Ast.ProjectionExpression2) {
            assert(ast.projections.length === 1);
            return ast.projections[0].prettyprint();
        }
        return null;
    }

    convertExpression(ast : Ast.Expression, subjectProperties : string[] = [], isMainExpression = true, variableMapping : Record<string, string> = {}) : string[] {
        // save out of scope variable mapping, load in scope variable mapping 
        const outVariableMapping = this._variableMap;
        this._variableMap = variableMapping;

        const tableInfoVisitor = new TableInfoVisitor(this);
        ast.visit(tableInfoVisitor);
        let subject;
        if (tableInfoVisitor.subject) {
            subject = tableInfoVisitor.subject;
        } else {
            if (this._variableMap['id'])
                subject = '?' + this._variableMap['id'];
            else 
                subject = '?' + this.getEntityVariable();
        }
        if (isMainExpression && subject.startsWith('?'))
            this.setResultVariable(subject);
        const domain = tableInfoVisitor.domainName ? this.getWikidataDomain(tableInfoVisitor.domainName) : null;
        this._variableMap = variableMapping;
        const tripleGenerator = new TripleGenerator(this, subject, subjectProperties, isMainExpression ? this._targetProjectionName(ast) : null, domain);
        ast.visit(tripleGenerator);

        // restore out of scope variable
        this._variableMap = outVariableMapping;
        return tripleGenerator.statements;
    }

    async convert(utterance : string, thingtalk : string) : Promise<string> {
        this._reset();

        // preprocess
        thingtalk = await this._preprocessor.preprocess(thingtalk, 'thingtalk');

        // try pattern match first
        const patternConverterResult = this._patternConverter.toSPARQL(thingtalk);
        if (patternConverterResult)
            return patternConverterResult;

        const entities = EntityUtils.makeDummyEntities(utterance);
        const ast = Syntax.parse(thingtalk, Syntax.SyntaxType.Tokenized, entities, {
            locale : this._locale, timezone: this._timezone
        });
        assert(ast instanceof Ast.Program);
        const expr = (ast.statements[0] as Ast.ExpressionStatement).expression;
        assert(expr instanceof Ast.ChainExpression && expr.expressions.length === 1);
        const table = expr.expressions[0];

        // hack: collect properties for the subject
        // node visitors can not be async, so we need to prepare this information ahead of time
        // this won't work for subquery where subject is different
        const tableInfoVisitor = new TableInfoVisitor(this);
        table.visit(tableInfoVisitor);
        const properties = [];
        if (tableInfoVisitor.subject) {
            const subject = tableInfoVisitor.subject.slice(ENTITY_PREFIX.length + 1, -1);
            const connectedProperties = await this._kb.getConnectedProperty(subject, false);
            const connectedQualifiers = await this._kb.getConnectedPropertyQualifiers(subject, connectedProperties);
            properties.push(...connectedProperties, ...connectedQualifiers);
        }

        const statements = await this.convertExpression(table, properties);  
        statements.forEach((stmt) => this.addStatement(stmt));

        let sparql = '';
        // ask/select
        if (this._isBooleanQuestion) 
            sparql += 'ASK '; 
        else if (this._aggregation) 
            sparql += `SELECT ${aggregationToString(this._aggregation)} `;
        else  
            sparql += `SELECT DISTINCT ${this._resultVariable} `;

        // where clauses
        sparql += `WHERE { ${this._statements.join((' '))} }`;

        // having clauses
        if (this._having.length > 0)
            sparql += ` GROUP BY ${this._resultVariable} HAVING(${this._having.join(' && ')})`;
        
        // order claueses
        if (this._order)
            sparql += ` ORDER BY ${this._order.direction === 'desc'? `DESC(${this._order.variable})` : this._order.variable}`;
        if (this._limit)
            sparql += ` LIMIT ${this._limit}`;
        return sparql;
    }
}