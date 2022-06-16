import { Type } from 'thingtalk';
export declare const ENTITY_PREFIX = "http://www.wikidata.org/entity/";
export declare const PROPERTY_PREFIX = "http://www.wikidata.org/prop/direct/";
export declare const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
interface Qualifier {
    name: string;
    type: Type;
}
export default class WikidataUtils {
    private _wdk;
    private _cachePath;
    private _cache;
    private _bootleg;
    private _cacheLoaded;
    private _properties;
    qualifiers: Record<string, Qualifier>;
    constructor(cachePath: string, bootlegPath: string);
    /**
     * Load or create sqlite database for caching
     */
    private _loadOrCreateSqliteCache;
    /**
     * Get cache
     * @param table the name of the table
     * @param field the filed of projection
     * @param constraint the constraint to apply to the retrieval
     * @returns undefined if not found, otherwise in the format of { result : string }
     */
    private _getCache;
    /**
     * Set cache
     * @param table the name of the table
     * @param values all the values to add to the table
     * @returns undefined
     */
    private _setCache;
    /**
     * Obtain results of a SPARQL query against Wikidata SPARQL endpoint
     * @param sparql a SPARQL query
     * @returns A list of the results
     */
    private _query;
    /**
     * Obtain results of URL in JSON form (Wikibase API call)
     * @param url
     * @param caching enable caching for the request or not
     * @returns An object of the result
     */
    private _request;
    /**
     * Obtain the values of property for a given entity
     * @param entityId QID of an entity
     * @param propertyId PID of an entity
     * @returns values of the property
     */
    getPropertyValue(entityId: string, propertyId: string): Promise<string[]>;
    /**
     * Get the domain of a given entity:
     * if there are multiple domains, pick the one that has the most instances;
     * we skip this on human (Q5) and taxon (Q16521) domain, since the query will timeout
     * @param entityId QID of an entity
     * @returns
     */
    getDomain(entityId: string): Promise<string | null>;
    /**
     * Get the Wikidata label for an entity or a property
     * @param id QID or PID
     * @returns natural language label in English
     */
    getLabel(id: string): Promise<string | null>;
    /**
     * Get the Wikidata alt label for an entity or a property
     * @param id QID or PID
     * @returns an array of alternative labels in English
     */
    getAltLabels(id: string): Promise<string[]>;
    /**
     * Get the wikidata label for a list of entities/properties.
     * The API allows up to 50 entities/properties at a time.
     * @param qids a list of QIDs or PIDs
     * @returns A map from id to label
     */
    getLabelsByBatch(...ids: string[]): Promise<Record<string, string | null>>;
    /**
     * Get example entities for the given domain
     *
     * Examples are sorted based on sitelinks.
     * Order by sitelinks in human (Q5), painting (Q3305213), and taxon (Q16521) domain
     * will lead to timeout, thus handle these three domains specially
     *
     * @param domain QID of the domain
     * @param limit the maximum number of entities to return
     * @returns an array of QIDs belongs to the given domain
     */
    getEntitiesByDomain(domain: string, limit?: number): Promise<string[]>;
    /**
     * Get properties for a given domain
     *
     * First get 100 example entities in the domain, and then extract all properties
     * they use
     *
     * @param domain QID of the domain
     * @param includeNonEntityProperties include properties whose values are not Wikidata entities
     * @returns an array of PIDs belongs to the given domain
     */
    getDomainProperties(domain: string, includeNonEntityProperties?: boolean): Promise<string[]>;
    /**
     * Given a domain and a property, find if the property has the pre-selected qualifiers
     * Currently, only start time, end time, and point in time
     * @param domain QID
     * @param property PID
     * @returns a list of qualifiers PID
     */
    getQualifiersByProperty(domain: string, property: string): Promise<string[]>;
    /**
     * Get properties and their values for a given domain
     *
     * First get 100 example entities in the domain, and then extract all properties
     * they use and their values
     *
     * @param domain QID of the domain
     * @param includeNonEntityProperties include properties whose values are not Wikidata entities
     * @returns an object where key is property PID, values are either an array of string/entity objects, or a type
     */
    getDomainPropertiesAndValues(domain: string, includeNonEntityProperties?: boolean): Promise<Record<string, any>>;
    /**
     * Get properties that are marked as "Wikidata property with datatype 'time'"
     *
     * @returns a list of property ids
     */
    getTimeProperties(): Promise<any>;
    /**
     * Get the allowed units (Q21514353) of a property
     * This allows to detect Measure types
     *
     * @param propertyId
     * @returns A list of allowed units
     */
    getAllowedUnits(propertyId: string): Promise<string[]>;
    /**
     * Get range constraint
     *
     * @param propertyId
     * @returns range or null
     */
    getRangeConstraint(propertyId: string): Promise<Record<string, number> | null>;
    /**
     * Return
     * @param propertyId
     * @returns wikibaseType
     */
    getPropertyType(propertyId: string): Promise<string>;
    /**
     * guess if the thingtalk type of a value is string
     * @param value a string of value
     * @returns if the value is a string value
     */
    isStringValue(value: string): boolean;
    /**
     * guess if the thingtalk type of a value is number
     * @param value a string of value
     * @returns if the value is a number value
     */
    isNumber(value: string): boolean;
    /**
     * guess if the thingtalk type of a value is entity
     * @param value a string of value
     * @returns if the value is a entity value
     */
    isEntity(value: string): boolean;
}
export {};
