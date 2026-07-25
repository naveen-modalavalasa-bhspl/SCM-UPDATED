// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Select, DatePicker, Button, Table, Tag, Space, Spin, Empty, Typography } from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import api from '../config/api';
import PageHeader from '../components/PageHeader';
import { downloadExcel, formatNumber, formatCurrency } from '../utils/helpers';
import useAuthStore from '../store/authStore';

const { RangePicker } = DatePicker;
const { Text } = Typography;

const REPORT_TYPES = [
  { label: 'Material Issues Transaction Log', value: 'material_issues_log' },
  { label: 'Goods Receipt Notes (GRN) Log', value: 'grn_log' },
  { label: 'Putaway Transaction Log', value: 'putaway_log' },
  { label: 'Material Inwards Transaction Log', value: 'material_inwards_log' },
  { label: 'Putaway Turnaround Logs (SLA)', value: 'putaway_efficiency' },
  { label: 'Pick Rate & SLA Violations (SLA)', value: 'pick_sla' },
  { label: 'QA Pass/Fail & Vendor Rejection Log (SLA)', value: 'qa_log' },
  { label: 'Gate Entry & Inwarding Logistics Log (SLA)', value: 'gate_log' },
];

const WarehouseReports = () => {
  const user = useAuthStore((s) => s.user);
  const [reportType, setReportType] = useState('material_issues_log');
  const [dateRange, setDateRange] = useState(null);
  const [warehouse, setWarehouse] = useState(user?.warehouse_id || undefined);
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);
  const [chartData, setChartData] = useState([]);

  useEffect(() => {
    fetchWarehouses();
    loadReportData();
  }, [reportType, warehouse, dateRange]);

  const fetchWarehouses = async () => {
    try {
      const res = await api.get('/warehouse/warehouses', { params: { page_size: 100, exclude_virtual: true } });
      const items = res.data?.items || res.data || [];
      setWarehouses(items.map(w => ({ label: w.name, value: w.id })));
    } catch {
      // silent fallback
    }
  };

  const loadReportData = async () => {
    setLoading(true);
    try {
      const params = { page_size: 100 };
      if (warehouse && reportType !== 'qa_log' && reportType !== 'gate_log') {
        params.warehouse_id = warehouse;
      }

      if (reportType === 'putaway_efficiency') {
        const res = await api.get('/warehouse/putaways', { params });
        const putaways = res.data?.items || res.data || [];

        let filtered = putaways;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = putaways.filter(p => {
            const dateVal = p.completed_at || p.started_at || p.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        // Group by month of completed_at
        const monthMap = {};
        filtered.forEach(p => {
          if (p.status !== 'completed' || !p.completed_at || !p.started_at) return;
          const date = new Date(p.completed_at);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, totalHours: 0, count: 0, itemsPutaway: 0 };
          }
          const start = new Date(p.started_at).getTime();
          const end = new Date(p.completed_at).getTime();
          const hours = Math.max(0, (end - start) / (1000 * 3600));
          monthMap[monthStr].totalHours += hours;
          monthMap[monthStr].count += 1;
          monthMap[monthStr].itemsPutaway += (p.completed_items || p.total_items || 0);
        });
        const list = Object.values(monthMap).map(m => ({
          name: m.name,
          avgHours: parseFloat((m.totalHours / m.count).toFixed(1)),
          targetHours: 8.0,
          itemsPutaway: m.itemsPutaway
        }));
        setData(list);
        setChartData(list);
      } else if (reportType === 'pick_sla') {
        const res = await api.get('/outbound/picking-orders', { params });
        const picks = res.data?.items || res.data || [];

        let filtered = picks;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = picks.filter(p => {
            const dateVal = p.completed_at || p.assigned_at || p.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const zoneMap = {};
        filtered.forEach(p => {
          const zone = p.warehouse_name || 'Main Zone';
          if (!zoneMap[zone]) {
            zoneMap[zone] = { zone, totalPicks: 0, breachedPicks: 0 };
          }
          zoneMap[zone].totalPicks += 1;
          if (p.status === 'completed' && p.completed_at && p.assigned_at) {
            const durationHrs = (new Date(p.completed_at).getTime() - new Date(p.assigned_at).getTime()) / (1000 * 3600);
            if (durationHrs > 4.0) { // SLA breach if > 4 hours
              zoneMap[zone].breachedPicks += 1;
            }
          } else if (p.status !== 'completed' && p.created_at) {
            const pendingHrs = (new Date().getTime() - new Date(p.created_at).getTime()) / (1000 * 3600);
            if (pendingHrs > 24.0) {
              zoneMap[zone].breachedPicks += 1;
            }
          }
        });
        const list = Object.values(zoneMap).map(z => ({
          zone: z.zone,
          totalPicks: z.totalPicks,
          breachedPicks: z.breachedPicks,
          compliance: parseFloat(((z.totalPicks - z.breachedPicks) / z.totalPicks * 100).toFixed(1))
        }));
        setData(list);
        setChartData(list);
      } else if (reportType === 'qa_log') {
        const res = await api.get('/warehouse/quality-inspections', { params });
        const inspections = res.data?.items || res.data || [];

        let filtered = inspections;
        if (warehouse) {
          filtered = inspections.filter(qi => Number(qi.warehouse_id || qi.grn?.warehouse_id) === Number(warehouse));
        }
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = filtered.filter(qi => {
            const dateVal = qi.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const vendorMap = {};
        filtered.forEach(qi => {
          const vendor = qi.vendor_name || qi.grn?.vendor_name || 'Vendor';
          if (!vendorMap[vendor]) {
            vendorMap[vendor] = { vendor, passed: 0, failed: 0, totalInspected: 0 };
          }
          vendorMap[vendor].totalInspected += 1;
          if (qi.overall_result === 'pass') {
            vendorMap[vendor].passed += 1;
          } else if (qi.overall_result === 'fail') {
            vendorMap[vendor].failed += 1;
          } else {
            vendorMap[vendor].passed += 1;
          }
        });
        const list = Object.values(vendorMap);
        setData(list);
        setChartData(list);
      } else if (reportType === 'gate_log') {
        const res = await api.get('/warehouse/gate-entries', { params });
        const entries = res.data?.items || res.data || [];

        let filtered = entries;
        if (warehouse) {
          filtered = entries.filter(e => Number(e.warehouse_id) === Number(warehouse));
        }
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = filtered.filter(e => {
            const dateVal = e.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const dateMap = {};
        filtered.forEach(e => {
          if (!e.created_at) return;
          const dateStr = new Date(e.created_at).toISOString().split('T')[0];
          if (!dateMap[dateStr]) {
            dateMap[dateStr] = { date: dateStr, entries: 0, waitSum: 0, maxWait: 0 };
          }
          dateMap[dateStr].entries += 1;

          if (e.gate_in_time) {
            const raised = new Date(e.created_at).getTime();
            const gateIn = new Date(e.gate_in_time).getTime();
            const waitMins = Math.max(0, (gateIn - raised) / (1000 * 60));
            dateMap[dateStr].waitSum += waitMins;
            if (waitMins > dateMap[dateStr].maxWait) {
              dateMap[dateStr].maxWait = waitMins;
            }
          }
        });
        const list = Object.values(dateMap).map(d => ({
          date: d.date,
          entries: d.entries,
          avgWaitMins: d.entries > 0 ? Math.round(d.waitSum / d.entries) : 0,
          maxWaitMins: Math.round(d.maxWait)
        }));
        setData(list);
        setChartData(list);
      }


      // --- NEW TRANSACTION LOG REPORTS ---
      else if (reportType === 'material_issues_log') {
        const res = await api.get('/warehouse/material-issues', { params });
        const issues = res.data?.items || res.data || [];

        let filtered = issues;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = issues.filter(mi => {
            const dateVal = mi.issue_date || mi.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const monthMap = {};
        filtered.forEach(mi => {
          const dateVal = mi.issue_date || mi.created_at;
          if (!dateVal) return;
          const date = new Date(dateVal);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, count: 0, totalQty: 0 };
          }
          monthMap[monthStr].count += 1;
          const items = mi.items || [];
          const qty = items.reduce((sum, it) => sum + (parseFloat(it.qty) || 0), 0);
          monthMap[monthStr].totalQty += qty;
        });


        const chartList = Object.values(monthMap).sort((a, b) => new Date(a.name) - new Date(b.name));

        // Flatten to serial-level rows with precomputed rowSpan values
        // Pass 1: build raw rows with _issueId, _itemKey, _serial, _colorIdx
        const rawRows = [];
        let colorIdx = 0;
        const seenIssues = {};
        filtered.forEach(mi => {
          const miId = mi.id || mi.issue_number;
          if (seenIssues[miId] === undefined) {
            seenIssues[miId] = colorIdx++;
          }
          const miColor = seenIssues[miId];
          const miItems = mi.items || [];
          if (miItems.length === 0) {
            rawRows.push({ ...mi, _item: null, _serial: null, _issueId: miId, _itemKey: null, _colorIdx: miColor });
          } else {
            miItems.forEach((item, itemIdx) => {
              const itemKey = `${miId}_${item.item_id || item.id || itemIdx}`;
              const serials = item.serial_numbers || [];
              if (serials.length === 0) {
                rawRows.push({ ...mi, _item: item, _serial: null, _issueId: miId, _itemKey: itemKey, _colorIdx: miColor });
              } else {
                serials.forEach(serial => {
                  rawRows.push({ ...mi, _item: item, _serial: serial, _issueId: miId, _itemKey: itemKey, _colorIdx: miColor });
                });
              }
            });
          }
        });

        // Pass 2: compute rowSpan counts
        const issueCount = {};
        const itemCount = {};
        rawRows.forEach(row => {
          issueCount[row._issueId] = (issueCount[row._issueId] || 0) + 1;
          if (row._itemKey) itemCount[row._itemKey] = (itemCount[row._itemKey] || 0) + 1;
        });

        // Pass 3: mark first rows and attach rowSpan
        const issueSeen = new Set();
        const itemSeen = new Set();
        const flatRows = rawRows.map(row => {
          const firstIssue = !issueSeen.has(row._issueId);
          if (firstIssue) issueSeen.add(row._issueId);
          const firstItem = row._itemKey && !itemSeen.has(row._itemKey);
          if (firstItem) itemSeen.add(row._itemKey);
          return {
            ...row,
            _issueRowSpan: firstIssue ? issueCount[row._issueId] : 0,
            _itemRowSpan: row._itemKey ? (firstItem ? itemCount[row._itemKey] : 0) : 1,
            _isFirstOfIssue: firstIssue,
          };
        });

        setChartData(chartList);
        setData(flatRows);
      } else if (reportType === 'grn_log') {
        const res = await api.get('/warehouse/grn', { params });
        const grns = res.data?.items || res.data || [];

        let filtered = grns;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = grns.filter(g => {
            const dateVal = g.grn_date || g.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const monthMap = {};
        filtered.forEach(g => {
          const dateVal = g.grn_date || g.created_at;
          if (!dateVal) return;
          const date = new Date(dateVal);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, count: 0, acceptedQty: 0, rejectedQty: 0 };
          }
          monthMap[monthStr].count += 1;
          monthMap[monthStr].acceptedQty += parseFloat(g.accepted_qty || 0);
          monthMap[monthStr].rejectedQty += parseFloat(g.rejected_qty || 0);
        });

        const chartList = Object.values(monthMap).sort((a, b) => new Date(a.name) - new Date(b.name));
        setChartData(chartList);
        setData(filtered);
      } else if (reportType === 'putaway_log') {
        const res = await api.get('/warehouse/putaways', { params });
        const putaways = res.data?.items || res.data || [];

        let filtered = putaways;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = putaways.filter(p => {
            const dateVal = p.completed_at || p.started_at || p.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const monthMap = {};
        filtered.forEach(p => {
          const dateVal = p.completed_at || p.started_at || p.created_at;
          if (!dateVal) return;
          const date = new Date(dateVal);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, count: 0, completedItems: 0 };
          }
          monthMap[monthStr].count += 1;
          monthMap[monthStr].completedItems += parseFloat(p.completed_items || 0);
        });

        const chartList = Object.values(monthMap).sort((a, b) => new Date(a.name) - new Date(b.name));
        setChartData(chartList);
        setData(filtered);
      } else if (reportType === 'material_inwards_log') {
        const res = await api.get('/warehouse/inwards', { params });
        const inwards = res.data?.items || res.data || [];

        let filtered = inwards;
        if (dateRange && dateRange[0] && dateRange[1]) {
          const start = dateRange[0].startOf('day').toDate();
          const end = dateRange[1].endOf('day').toDate();
          filtered = inwards.filter(inw => {
            const dateVal = inw.received_date || inw.created_at;
            if (!dateVal) return false;
            const d = new Date(dateVal);
            return d >= start && d <= end;
          });
        }

        if (filtered.length === 0) {
          setData([]);
          setChartData([]);
          setLoading(false);
          return;
        }

        const monthMap = {};
        filtered.forEach(inw => {
          const dateVal = inw.received_date || inw.created_at;
          if (!dateVal) return;
          const date = new Date(dateVal);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, count: 0, itemsCount: 0 };
          }
          monthMap[monthStr].count += 1;
          monthMap[monthStr].itemsCount += (inw.items || []).length;
        });

        const chartList = Object.values(monthMap).sort((a, b) => new Date(a.name) - new Date(b.name));
        setChartData(chartList);
        setData(filtered);
      }
    } catch (err) {
      console.error('Failed to load warehouse report data:', err);
      setData([]);
      setChartData([]);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    const title = REPORT_TYPES.find(r => r.value === reportType)?.label || 'Report';

    // For material_issues_log we produce serial-level rows (one row per serial number)
    if (reportType === 'material_issues_log') {
      const exportRows = data.map(row => ({
        'Issue Number': row.issue_number || '-',
        'Issue Date': row.issue_date ? new Date(row.issue_date).toLocaleDateString() : '-',
        'Source Warehouse': row.warehouse_name || '-',
        'Destination Warehouse': row.destination_warehouse_name || '-',
        'Vehicle Code': row.vehicle_code || '-',
        'Vehicle Number': row.vehicle_number || '-',
        'Item Name': row._item?.item_name || '-',
        'Item Code': row._item?.item_code || '-',
        'Item Type': row._item?.item_type || '-',
        'Qty Issued': row._itemRowSpan > 0 ? (row._item?.qty ?? '-') : '',
        'Serial / Asset No': row._serial || '-',
        'Department': row.department || '-',
        'Issued To': row.issued_to_name || row.issued_to || '-',
        'Status': row.status || '-',
      }));
      downloadExcel(exportRows, `warehouse_${reportType}`, title);
      return;
    }

    // Structure export data to match UI columns for better readability
    const cols = getColumns();
    const exportData = data.map((row) => {
      const exp = {};
      cols.forEach((c) => {
        if (c.dataIndex && c.title) {
          exp[c.title] = row[c.dataIndex];
        } else if (c.key && c.title) {
          if (c.key === 'items_count' && row.items) {
            exp[c.title] = row.items.length;
          } else if (c.key === 'total_qty' && row.items) {
            exp[c.title] = row.items.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
          } else if (c.key === 'progress') {
            exp[c.title] = `${row.completed_items || 0} / ${row.total_items || 0}`;
          } else {
            exp[c.title] = row[c.key];
          }
        }
      });
      return exp;
    });

    downloadExcel(exportData.length ? exportData : data, `warehouse_${reportType}`, title);
  };

  const getColumns = () => {
    if (reportType === 'putaway_efficiency') {
      return [
        { title: 'Period', dataIndex: 'name', key: 'name' },
        { title: 'Avg Putaway TAT (Hours)', dataIndex: 'avgHours', key: 'avgHours', align: 'right', render: (v) => `${v} hrs` },
        { title: 'SLA Target TAT', dataIndex: 'targetHours', key: 'targetHours', align: 'right', render: (v) => `${v} hrs` },
        { title: 'Items Putaway', dataIndex: 'itemsPutaway', key: 'itemsPutaway', align: 'right' },
      ];
    } else if (reportType === 'pick_sla') {
      return [
        { title: 'Storage Zone', dataIndex: 'zone', key: 'zone' },
        { title: 'Total Picks', dataIndex: 'totalPicks', key: 'totalPicks', align: 'right' },
        { title: 'SLA Breached Picks', dataIndex: 'breachedPicks', key: 'breachedPicks', align: 'right', render: (v) => <span style={{ color: v > 15 ? '#f5222d' : '#fa8c16' }}>{v}</span> },
        {
          title: 'SLA Compliance Rate',
          dataIndex: 'compliance',
          key: 'compliance',
          align: 'right',
          render: (v) => <span style={{ fontWeight: 600, color: v > 90 ? '#52c41a' : '#fa8c16' }}>{v}%</span>
        },
      ];
    } else if (reportType === 'qa_log') {
      return [
        { title: 'Vendor Name', dataIndex: 'vendor', key: 'vendor' },
        { title: 'Inspected Batches', dataIndex: 'totalInspected', key: 'totalInspected', align: 'right' },
        { title: 'Passed Batches', dataIndex: 'passed', key: 'passed', align: 'right', render: (v) => <span style={{ color: '#52c41a' }}>{v}</span> },
        { title: 'Failed Batches', dataIndex: 'failed', key: 'failed', align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : 'inherit' }}>{v}</span> },
        {
          title: 'Rejection Rate (%)',
          key: 'rejection_rate',
          align: 'right',
          render: (_, r) => {
            const rate = ((r.failed / r.totalInspected) * 100).toFixed(1);
            return <span style={{ fontWeight: 600, color: rate > 10 ? '#f5222d' : 'inherit' }}>{rate}%</span>;
          }
        },
      ];
    } else if (reportType === 'gate_log') {
      return [
        { title: 'Date', dataIndex: 'date', key: 'date' },
        { title: 'Total Vehicles Registered', dataIndex: 'entries', key: 'entries', align: 'right' },
        { title: 'Average Yard Wait Time', dataIndex: 'avgWaitMins', key: 'avgWaitMins', align: 'right', render: (v) => `${v} mins` },
        { title: 'Max Yard Wait Time', dataIndex: 'maxWaitMins', key: 'maxWaitMins', align: 'right', render: (v) => `${v} mins` },
      ];
    } else if (reportType === 'material_issues_log') {
      // Issue-level cell helper (merged across all rows of same issue)
      const issueCell = (content, row) => ({
        children: content,
        props: { rowSpan: row._issueRowSpan ?? 1 },
      });
      // Item-level cell helper (merged across all serial rows of same item)
      const itemCell = (content, row) => ({
        children: content,
        props: { rowSpan: row._itemRowSpan ?? 1 },
      });
      return [
        {
          title: 'Issue Number', key: 'issue_number', width: 150, fixed: 'left',
          render: (_, row) => issueCell(
            <div>
              <div style={{ fontWeight: 700, color: '#1d3557', fontSize: 13 }}>{row.issue_number || '-'}</div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                {row.issue_date ? new Date(row.issue_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}
              </div>
            </div>, row),
        },
        {
          title: 'Source → Destination', key: 'warehouses', width: 220,
          render: (_, row) => issueCell(
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{row.warehouse_name || '-'}</div>
              <div style={{ fontSize: 11, color: '#888' }}>→ {row.destination_warehouse_name || 'N/A'}</div>
            </div>, row),
        },
        {
          title: 'Vehicle', key: 'vehicle', width: 150,
          render: (_, row) => issueCell(
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{row.vehicle_code || '—'}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{row.vehicle_number || ''}</div>
            </div>, row),
        },
        {
          title: 'Department / Issued To', key: 'dept_to', width: 170,
          render: (_, row) => issueCell(
            <div>
              <div style={{ fontSize: 12 }}>{row.department || '—'}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{row.issued_to_name || row.issued_to || ''}</div>
            </div>, row),
        },
        {
          title: 'Status', key: 'status', width: 100,
          render: (_, row) => issueCell(
            <Tag color={row.status === 'completed' || row.status === 'issued' ? 'green' : row.status === 'cancelled' ? 'red' : 'blue'} style={{ fontSize: 11 }}>
              {(row.status || '').toUpperCase()}
            </Tag>, row),
        },
        {
          title: 'Item Name', key: 'item_name', width: 200,
          render: (_, row) => itemCell(
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{row._item?.item_name || '—'}</div>
              <div style={{ fontSize: 11, color: '#888' }}>{row._item?.item_code || ''}</div>
            </div>, row),
        },
        {
          title: 'Type', key: 'item_type', width: 100,
          render: (_, row) => itemCell(
            row._item?.item_type
              ? <Tag color={row._item.item_type === 'asset' ? 'gold' : row._item.item_type === 'consumable' ? 'cyan' : 'default'} style={{ fontSize: 11 }}>
                  {row._item.item_type.toUpperCase()}
                </Tag>
              : <span style={{ color: '#bbb' }}>—</span>, row),
        },
        {
          title: 'Qty', key: 'qty', width: 70, align: 'right',
          render: (_, row) => itemCell(
            <span style={{ fontWeight: 600 }}>{row._item?.qty ?? '—'}</span>, row),
        },
        {
          title: 'Serial / Asset No',
          key: 'serial',
          width: 180,
          render: (_, row) =>
            row._serial
              ? <span style={{ fontFamily: 'monospace', fontSize: 12, background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 4, padding: '2px 6px', display: 'inline-block' }}>
                  {row._serial}
                </span>
              : <span style={{ color: '#bbb', fontSize: 12 }}>No serial</span>,
        },
      ];
    } else if (reportType === 'grn_log') {
      return [
        { title: 'GRN Number', dataIndex: 'grn_number', key: 'grn_number' },
        { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', render: (v, r) => v || r.vendor || '-' },
        { title: 'PO Ref', dataIndex: 'po_number', key: 'po_number' },
        { title: 'Inward Ref', dataIndex: 'inward_number', key: 'inward_number' },
        { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse' },
        { title: 'GRN Date', dataIndex: 'grn_date', key: 'grn_date', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
        { title: 'Supplier Invoice', dataIndex: 'supplier_invoice', key: 'supplier_invoice' },
        { title: 'Total Qty', dataIndex: 'total_qty', key: 'total_qty', align: 'right', render: (v) => formatNumber(v) },
        { title: 'Accepted Qty', dataIndex: 'accepted_qty', key: 'accepted_qty', align: 'right', render: (v) => <span style={{ color: '#52c41a' }}>{formatNumber(v)}</span> },
        { title: 'Rejected Qty', dataIndex: 'rejected_qty', key: 'rejected_qty', align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : 'inherit' }}>{formatNumber(v)}</span> },
        { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'completed' ? 'green' : s === 'cancelled' ? 'red' : 'blue'}>{(s || '').toUpperCase()}</Tag> }
      ];
    } else if (reportType === 'putaway_log') {
      return [
        { title: 'Putaway Number', dataIndex: 'putaway_number', key: 'putaway_number' },
        { title: 'GRN Reference', dataIndex: 'grn_number', key: 'grn_number' },
        { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse' },
        { title: 'Putaway Type', dataIndex: 'putaway_type', key: 'putaway_type', render: (v) => v === 'system_directed' ? 'System Directed' : 'Manual' },
        { title: 'Assigned To', dataIndex: 'assigned_to_name', key: 'assigned_to', render: (v, r) => v || r.assigned_to || '-' },
        { title: 'Progress', key: 'progress', align: 'right', render: (_, r) => `${r.completed_items || 0} / ${r.total_items || 0}` },
        { title: 'Started At', dataIndex: 'started_at', key: 'started_at', render: (v) => v ? new Date(v).toLocaleString() : '-' },
        { title: 'Completed At', dataIndex: 'completed_at', key: 'completed_at', render: (v) => v ? new Date(v).toLocaleString() : '-' },
        { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'completed' ? 'green' : s === 'cancelled' ? 'red' : 'blue'}>{(s || '').toUpperCase()}</Tag> }
      ];
    } else if (reportType === 'material_inwards_log') {
      return [
        { title: 'Inward Number', dataIndex: 'inward_number', key: 'inward_number' },
        { title: 'PO Number', dataIndex: 'po_number', key: 'po_number' },
        { title: 'Vendor', key: 'vendor', render: (_, r) => r.vendor_name || r.vendor_name_manual || '-' },
        { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse' },
        { title: 'Received Date', dataIndex: 'received_date', key: 'received_date', render: (v) => v ? new Date(v).toLocaleDateString() : '-' },
        { title: 'Vehicle Number', dataIndex: 'vehicle_number', key: 'vehicle_number' },
        { title: 'Items Count', key: 'items_count', align: 'right', render: (_, r) => (r.items || []).length },
        { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <Tag color={s === 'received' || s === 'grn_created' ? 'green' : s === 'cancelled' ? 'red' : 'blue'}>{(s || '').toUpperCase()}</Tag> }
      ];
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader
        title="Warehouse Logistics & Transaction Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ borderRadius: '6px' }}>
          Export Excel
        </Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={8}>
            <Select
              placeholder="Select Report"
              style={{ width: '100%' }}
              value={reportType}
              onChange={setReportType}
              options={REPORT_TYPES}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Select
              placeholder="Filter Warehouse"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              value={warehouse}
              onChange={setWarehouse}
              options={warehouses}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <RangePicker
              style={{ width: '100%' }}
              value={dateRange}
              onChange={setDateRange}
            />
          </Col>
          <Col xs={24} md={4}>
            <Button
              type="primary"
              icon={<FilterOutlined />}
              onClick={loadReportData}
              block
              style={{ background: '#F09000', borderColor: '#F09000', borderRadius: '6px' }}
            >
              Apply Filter
            </Button>
          </Col>
        </Row>
      </Card>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '100px' }}>
          <Spin size="large" tip="Aggregating report data..." />
        </div>
      ) : (
        <>
          {/* Graphical Analysis */}
          <Card style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
            <div style={{ height: '350px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  {reportType === 'putaway_efficiency' ? (
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                      <YAxis label={{ value: 'Hours', angle: -90, position: 'insideLeft' }} stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="avgHours" name="Avg Putaway TAT (Hrs)" stroke="#F09000" strokeWidth={2.5} activeDot={{ r: 8 }} />
                      <Line type="monotone" dataKey="targetHours" name="SLA SLA Limit (Hrs)" stroke="#f5222d" strokeDasharray="5 5" strokeWidth={1.5} />
                    </LineChart>
                  ) : reportType === 'pick_sla' ? (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="zone" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="totalPicks" name="Total Picks" fill="#F09000" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="breachedPicks" name="SLA Breaches" fill="#fa541c" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : reportType === 'qa_log' ? (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="vendor" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="passed" name="Accepted Batches" fill="#52c41a" stackId="a" />
                      <Bar dataKey="failed" name="Rejected Batches" fill="#f5222d" stackId="a" />
                    </BarChart>
                  ) : reportType === 'gate_log' ? (
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#6C757D" tickLine={false} />
                      <YAxis label={{ value: 'Minutes', angle: -90, position: 'insideLeft' }} stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="avgWaitMins" name="Avg Wait (Mins)" stroke="#F09000" strokeWidth={2} />
                      <Line type="monotone" dataKey="maxWaitMins" name="Max Wait (Mins)" stroke="#fa541c" strokeWidth={2} />
                    </LineChart>
                  ) : reportType === 'material_issues_log' ? (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="count" name="Issues Count" fill="#F09000" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="totalQty" name="Total Qty Issued" fill="#1890ff" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : reportType === 'grn_log' ? (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="count" name="GRN Count" fill="#F09000" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="acceptedQty" name="Accepted Qty" fill="#52c41a" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="rejectedQty" name="Rejected Qty" fill="#f5222d" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : reportType === 'putaway_log' ? (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="count" name="Putaway Orders" fill="#F09000" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="completedItems" name="Completed Items" fill="#52c41a" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : (
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                      <YAxis stroke="#6C757D" tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="count" name="Inward Receipts" fill="#F09000" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="itemsCount" name="Total Inwarded Items" fill="#1890ff" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  )}
                </ResponsiveContainer>
              ) : (
                <Empty description="No report metrics available for the selected filters" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>

          {/* Details Table */}
          <Card
              title={
                reportType === 'material_issues_log'
                  ? <span>Material Issues — Item &amp; Serial Detail <span style={{ fontSize: 12, fontWeight: 400, color: '#888' }}>(one row per serial number)</span></span>
                  : 'Report Details Table'
              }
              style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}
            >
            <Table
              dataSource={data.map((item, index) => ({ ...item, key: index }))}
              columns={getColumns()}
              pagination={data.length > 20 ? { pageSize: 20, showSizeChanger: true } : false}
              size="small"
              scroll={{ x: 1200 }}
              bordered
              onRow={(row) => ({
                style: reportType === 'material_issues_log' ? {
                  backgroundColor: (row._colorIdx ?? 0) % 2 === 0 ? '#f0f4ff' : '#ffffff',
                  borderTop: row._isFirstOfIssue ? '2px solid #4361ee' : undefined,
                } : {},
              })}
            />
          </Card>
        </>
      )}
    </div>
  );
};

export default WarehouseReports;
