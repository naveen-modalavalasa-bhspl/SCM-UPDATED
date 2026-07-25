// @ts-nocheck
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Table, Input, Button, Space, Tooltip, Empty } from 'antd';
import {
  SearchOutlined,
  DownloadOutlined,
  PrinterOutlined,
  ReloadOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import { downloadExcel, debounce } from '../utils/helpers';

const DataTable = ({
  columns,
  dataSource: externalData,
  fetchFunction,
  extraParams,
  rowKey = 'id',
  searchPlaceholder = 'Search...',
  showSearch = true,
  showExport = true,
  showPrint = true,
  showRefresh = true,
  exportFileName = 'export',
  pageSize: defaultPageSize = 20,
  pageSizeOptions = ['10', '20', '50', '100'],
  scroll,
  bordered = false,
  size = 'middle',
  title: tableTitle,
  toolbar,
  onRow,
  rowSelection,
  expandable,
  summary,
  loading: externalLoading,
  initialSearch = '',
  customExport,
}) => {
  const [data, setData] = useState(externalData || []);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState(initialSearch);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: defaultPageSize,
    total: 0,
    showSizeChanger: true,
    pageSizeOptions,
    showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} items`,
  });
  const [sorter, setSorter] = useState({});
  const [filters, setFilters] = useState({});

  // extraParams: external filter values merged into every fetch call
  const extraParamsRef = useRef(extraParams || {});
  extraParamsRef.current = extraParams || {};
  const extraParamsJSON = JSON.stringify(extraParams || {});
  const printRef = useRef(null);

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: exportFileName,
  });

  const fetchFunctionRef = useRef(fetchFunction);
  fetchFunctionRef.current = fetchFunction;

  const fetchData = useCallback(
    async (params = {}) => {
      if (!fetchFunctionRef.current) return;
      setLoading(true);
      try {
        const queryParams = {
          page: params.current || pagination.current,
          page_size: params.pageSize || pagination.pageSize,
          search: params.search !== undefined ? params.search : searchText,
          ...(params.sortField && {
            sort_by: params.sortField,
            sort_order: params.sortOrder === 'ascend' ? 'asc' : 'desc',
          }),
          ...params.filters,
          // Merge in any external filter params (e.g. from filter dropdowns above the table)
          ...extraParamsRef.current,
        };

        Object.keys(queryParams).forEach((key) => {
          if (
            queryParams[key] === undefined ||
            queryParams[key] === null ||
            queryParams[key] === ''
          ) {
            delete queryParams[key];
          }
        });

        const response = await fetchFunctionRef.current(queryParams);
        const responseData = response.data || response;
        const items = responseData.items || responseData.data || responseData;
        const total =
          responseData.total
          || responseData.count
          || (responseData.pagination && responseData.pagination.total)
          || (Array.isArray(items) ? undefined : 0);

        const itemsArray = Array.isArray(items) ? items : [];
        setData(itemsArray);
        setPagination((prev) => ({
          ...prev,
          current: params.current || prev.current,
          pageSize: params.pageSize || prev.pageSize,
          total: total != null ? total : itemsArray.length,
        }));
      } catch (error) {
        console.error('DataTable fetch error:', error);
        setData([]);
      } finally {
        setLoading(false);
      }
    },
    [pagination.current, pagination.pageSize, searchText]
  );

  // Fetch on mount AND whenever extraParams change (filter selections).
  // This replaces the previous mount-only useEffect([], []) so that
  // changing a filter dropdown immediately re-fetches page 1.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fetchFunctionRef.current) {
      fetchData({ current: 1 });
    }
  }, [extraParamsJSON]);

  useEffect(() => {
    if (externalData) {
      setData(externalData);
      setPagination((prev) => ({
        ...prev,
        total: externalData.length,
      }));
    }
  }, [externalData]);

  const debouncedSearch = useCallback(
    debounce((value) => {
      if (fetchFunction) {
        fetchData({ current: 1, search: value });
      }
    }, 400),
    [fetchFunction]
  );

  useEffect(() => {
    return () => {
      debouncedSearch.cancel();
    };
  }, [debouncedSearch]);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    setSearchText(value);
    if (fetchFunction) {
      debouncedSearch(value);
    }
  };

  const handleTableChange = (pag, tableFilters, tableSorter) => {
    setSorter(tableSorter);
    setFilters(tableFilters);
    if (fetchFunction) {
      fetchData({
        current: pag.current,
        pageSize: pag.pageSize,
        sortField: tableSorter.field,
        sortOrder: tableSorter.order,
        filters: tableFilters,
      });
    } else {
      setPagination((prev) => ({
        ...prev,
        current: pag.current,
        pageSize: pag.pageSize,
      }));
    }
  };

  const handleExport = () => {
    if (typeof customExport === 'function') {
      customExport(data);
      return;
    }
    const exportData = data.map((row) => {
      const exportRow = {};
      columns.forEach((col) => {
        if (col.dataIndex && col.title) {
          const key =
            typeof col.dataIndex === 'string'
              ? col.dataIndex
              : col.dataIndex.join('.');
          let value = row;
          if (typeof col.dataIndex === 'string') {
            value = row[col.dataIndex];
          } else if (Array.isArray(col.dataIndex)) {
            value = col.dataIndex.reduce(
              (obj, k) => (obj ? obj[k] : undefined),
              row
            );
          }
          const title =
            typeof col.title === 'string' ? col.title : key;
          exportRow[title] = value;
        }
      });
      return exportRow;
    });
    downloadExcel(exportData, exportFileName);
  };

  const handleRefresh = () => {
    if (fetchFunction) {
      fetchData();
    }
  };

  const filteredData =
    !fetchFunction && searchText
      ? data.filter((row) =>
          Object.values(row).some((val) =>
            String(val || '')
              .toLowerCase()
              .includes(searchText.toLowerCase())
          )
        )
      : data;

  const isLoading =
    externalLoading !== undefined ? externalLoading : loading;

  return (
    <div className="data-table-wrapper" ref={printRef}>
      <div className="data-table-toolbar">
        <div className="data-table-toolbar-left">
          {showSearch && (
            <Input
              placeholder={searchPlaceholder}
              prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
              value={searchText}
              onChange={handleSearchChange}
              allowClear
              style={{ width: 280 }}
            />
          )}
          {toolbar}
        </div>
        <div className="data-table-toolbar-right no-print">
          {showRefresh && fetchFunction && (
            <Tooltip title="Refresh">
              <Button
                icon={<ReloadOutlined />}
                onClick={handleRefresh}
                loading={isLoading}
              />
            </Tooltip>
          )}
          {showExport && (
            <Tooltip title="Export to Excel">
              <Button
                icon={<DownloadOutlined />}
                onClick={handleExport}
                disabled={filteredData.length === 0}
              />
            </Tooltip>
          )}
          {showPrint && (
            <Tooltip title="Print">
              <Button
                icon={<PrinterOutlined />}
                onClick={handlePrint}
                disabled={filteredData.length === 0}
              />
            </Tooltip>
          )}
        </div>
      </div>
      <Table
        columns={columns}
        dataSource={filteredData}
        rowKey={rowKey}
        loading={isLoading}
        pagination={
          fetchFunction
            ? pagination
            : {
                ...pagination,
                total: filteredData.length,
                showSizeChanger: true,
                showTotal: (total, range) =>
                  `${range[0]}-${range[1]} of ${total} items`,
              }
        }
        onChange={handleTableChange}
        scroll={scroll || { x: 'max-content' }}
        bordered={bordered}
        size={size}
        onRow={onRow}
        rowSelection={rowSelection}
        expandable={expandable}
        summary={summary}
        locale={{
          emptyText: (
            <Empty
              image={<InboxOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
              description={
                searchText
                  ? 'No results match your search'
                  : 'No data available'
              }
            />
          ),
        }}
      />
    </div>
  );
};

export default DataTable;
